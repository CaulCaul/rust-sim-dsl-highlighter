import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    InstructionCall,
    RDSLAnalysis,
    RDSLSchema,
    analyzeRDSL,
    callAt,
    tokenAt,
} from './language';

const selector: vscode.DocumentSelector = {language: 'rdsl'};
const semanticLegend = new vscode.SemanticTokensLegend(['function', 'parameter', 'variable']);

/// 激活 schema 驱动的 RDSL 编辑器能力。
export function activate(context: vscode.ExtensionContext): void {
    const schema = loadSchema(context);
    const analysis = new AnalysisCache(schema);
    const diagnostics = vscode.languages.createDiagnosticCollection('rdsl');
    const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const updateDiagnostics = (document: vscode.TextDocument): void => {
        if (document.languageId !== 'rdsl') {
            return;
        }
        const enabled = vscode.workspace.getConfiguration('rdsl', document.uri)
            .get<boolean>('diagnostics.enable', true);
        if (!enabled) {
            diagnostics.delete(document.uri);
            return;
        }
        diagnostics.set(document.uri, analysis.get(document).issues.map(issue => {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
                issue.message,
                issue.severity === 'error'
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning,
            );
            diagnostic.source = 'rdsl';
            return diagnostic;
        }));
    };
    /// 合并连续编辑事件，避免大型 RDSL 在每次按键后同步重复分析。
    const scheduleDiagnostics = (document: vscode.TextDocument): void => {
        const key = document.uri.toString();
        const previous = diagnosticTimers.get(key);
        if (previous) {
            clearTimeout(previous);
        }
        diagnosticTimers.set(key, setTimeout(() => {
            diagnosticTimers.delete(key);
            updateDiagnostics(document);
        }, 200));
    };

    context.subscriptions.push(
        diagnostics,
        vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
        vscode.workspace.onDidChangeTextDocument(event => scheduleDiagnostics(event.document)),
        vscode.workspace.onDidCloseTextDocument(document => {
            const key = document.uri.toString();
            const timer = diagnosticTimers.get(key);
            if (timer) {
                clearTimeout(timer);
                diagnosticTimers.delete(key);
            }
            diagnostics.delete(document.uri);
            analysis.delete(document);
        }),
        new vscode.Disposable(() => {
            for (const timer of diagnosticTimers.values()) {
                clearTimeout(timer);
            }
            diagnosticTimers.clear();
        }),
        vscode.languages.registerCompletionItemProvider(selector, new CompletionProvider(schema, analysis), '.', '('),
        vscode.languages.registerHoverProvider(selector, new HoverProvider(analysis)),
        vscode.languages.registerSignatureHelpProvider(selector, new SignatureProvider(analysis), '(', ','),
        vscode.languages.registerInlayHintsProvider(selector, new InlayHintsProvider(analysis)),
        vscode.languages.registerDefinitionProvider(selector, new DefinitionProvider(analysis)),
        vscode.languages.registerReferenceProvider(selector, new ReferenceProvider(analysis)),
        vscode.languages.registerRenameProvider(selector, new RenameProvider(analysis)),
        vscode.languages.registerDocumentSymbolProvider(selector, new DocumentSymbolProvider(analysis)),
        vscode.languages.registerFoldingRangeProvider(selector, new FoldingProvider(analysis)),
        vscode.languages.registerDocumentSemanticTokensProvider(
            selector,
            new SemanticTokensProvider(analysis),
            semanticLegend,
        ),
        vscode.languages.registerDocumentFormattingEditProvider(selector, new FormattingProvider()),
    );
    for (const document of vscode.workspace.textDocuments) {
        updateDiagnostics(document);
    }
}

/// 扩展没有需要显式释放的全局资源。
export function deactivate(): void {}

/// 从扩展包内读取由 simulator schema 同步生成的快照。
function loadSchema(context: vscode.ExtensionContext): RDSLSchema {
    const filename = path.join(context.extensionPath, 'schemas', 'rdsl-schema.json');
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) as RDSLSchema;
    if (!Number.isInteger(parsed.schema_version) || !Array.isArray(parsed.instructions)) {
        throw new Error(`Invalid RDSL schema: ${filename}`);
    }
    return parsed;
}

/// 按文档版本缓存容错分析结果。
class AnalysisCache {
    private readonly cache = new Map<string, {version: number, analysis: RDSLAnalysis}>();

    constructor(private readonly schema: RDSLSchema) {}

    /// 返回当前文档版本的分析结果。
    get(document: vscode.TextDocument): RDSLAnalysis {
        const key = document.uri.toString();
        const cached = this.cache.get(key);
        if (cached?.version === document.version) {
            return cached.analysis;
        }
        const value = analyzeRDSL(document.getText(), this.schema);
        this.cache.set(key, {version: document.version, analysis: value});
        return value;
    }

    /// 删除已经关闭文档的缓存。
    delete(document: vscode.TextDocument): void {
        this.cache.delete(document.uri.toString());
    }
}

/// 提供指令、具名参数、变量和内建函数补全。
class CompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private readonly schema: RDSLSchema,
        private readonly cache: AnalysisCache,
    ) {}

    /// 根据光标所在调用决定补全参数或顶层语句。
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const analysis = this.cache.get(document);
        const offset = document.offsetAt(position);
        const call = callAt(analysis, offset);
        if (call?.spec) {
            const used = new Set(call.args.map(arg => arg.name));
            return call.spec.params
                .filter(param => !used.has(param.name))
                .map(param => {
                    const item = new vscode.CompletionItem(param.name, vscode.CompletionItemKind.Property);
                    item.detail = param.type + (param.optional ? ' (optional)' : '');
                    const placeholder = param.default === undefined ? placeholderForType(param.type) : JSON.stringify(param.default);
                    item.insertText = new vscode.SnippetString(`${param.name} = \${1:${placeholder}}`);
                    return item;
                });
        }
        const result = this.schema.instructions.map(spec => {
            const item = new vscode.CompletionItem(spec.name, vscode.CompletionItemKind.Function);
            item.detail = spec.doc;
            const params = spec.params.filter(param => !param.optional).map((param, index) =>
                `${param.name} = \${${index + 1}:${placeholderForType(param.type)}}`
            ).join(', ');
            item.insertText = new vscode.SnippetString(`${spec.name}(${params});`);
            return item;
        });
        for (const keyword of ['let', 'for', 'min', 'max', 'ceil_div']) {
            result.push(new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword));
        }
        for (const definition of analysis.definitions) {
            result.push(new vscode.CompletionItem(definition.name, vscode.CompletionItemKind.Variable));
        }
        return result;
    }
}

/// 为 snippet 参数类型返回安全的默认占位文本。
function placeholderForType(type: string): string {
    if (type === 'string') {
        return '"value"';
    }
    if (type === 'bool') {
        return 'false';
    }
    if (type.endsWith('_list')) {
        return '[]';
    }
    return '0';
}

/// 显示指令接口和变量定义信息。
class HoverProvider implements vscode.HoverProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 返回光标 token 对应的 Markdown 悬停信息。
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const analysis = this.cache.get(document);
        const token = tokenAt(analysis, document.offsetAt(position));
        if (!token) {
            return undefined;
        }
        const call = analysis.calls.find(value => value.nameToken === token);
        if (call?.spec) {
            const signature = `${call.spec.name}(${call.spec.params.map(param =>
                `${param.name}: ${param.type}${param.optional ? '?' : ''}`
            ).join(', ')})`;
            const markdown = new vscode.MarkdownString();
            markdown.appendCodeblock(signature, 'rdsl');
            markdown.appendMarkdown(call.spec.doc);
            return new vscode.Hover(markdown);
        }
        const definition = [...analysis.definitions]
            .reverse()
            .find(value => value.name === token.text && value.token.start <= token.start);
        if (definition) {
            return new vscode.Hover(`\`${definition.name}: ${definition.valueType ?? 'unknown'}\``);
        }
        return undefined;
    }
}

/// 在指令参数列表中显示 schema 签名和当前参数。
class SignatureProvider implements vscode.SignatureHelpProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 构造 VS Code 签名帮助对象。
    provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
        const analysis = this.cache.get(document);
        const offset = document.offsetAt(position);
        const call = callAt(analysis, offset);
        if (!call?.spec) {
            return undefined;
        }
        const signature = new vscode.SignatureInformation(
            `${call.name}(${call.spec.params.map(param => `${param.name}: ${param.type}${param.optional ? '?' : ''}`).join(', ')})`,
            call.spec.doc,
        );
        signature.parameters = call.spec.params.map(param =>
            new vscode.ParameterInformation(param.name, `${param.type}${param.optional ? '，可选' : ''}`)
        );
        const help = new vscode.SignatureHelp();
        help.signatures = [signature];
        help.activeSignature = 0;
        const activeArgument = call.args.find(arg => {
            const end = arg.valueTokens.at(-1)?.end ?? arg.nameToken.end;
            return arg.nameToken.start <= offset && offset <= end;
        });
        help.activeParameter = Math.max(0, call.spec.params.findIndex(param => param.name === activeArgument?.name));
        return help;
    }
}

/// 为 let/for 声明显示推导类型，不重复已经显式写出的参数名。
class InlayHintsProvider implements vscode.InlayHintsProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 返回可见范围内的变量类型提示。
    provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
        const enabled = vscode.workspace.getConfiguration('rdsl', document.uri)
            .get<boolean>('inlayHints.enable', true);
        if (!enabled) {
            return [];
        }
        return this.cache.get(document).definitions
            .filter(definition => definition.valueType)
            .filter(definition => range.contains(document.positionAt(definition.token.end)))
            .map(definition => {
                const hint = new vscode.InlayHint(
                    document.positionAt(definition.token.end),
                    `: ${definition.valueType}`,
                    vscode.InlayHintKind.Type,
                );
                hint.paddingLeft = false;
                hint.paddingRight = true;
                return hint;
            });
    }
}

/// 支持变量定义跳转。
class DefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 返回引用位置之前最近的同名定义。
    provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | undefined {
        const analysis = this.cache.get(document);
        const token = tokenAt(analysis, document.offsetAt(position));
        if (!token) {
            return undefined;
        }
        const definition = [...analysis.definitions]
            .reverse()
            .find(value => value.name === token.text && value.token.start <= token.start);
        return definition
            ? new vscode.Location(document.uri, tokenRange(document, definition.token))
            : undefined;
    }
}

/// 查找同一文档中的变量引用。
class ReferenceProvider implements vscode.ReferenceProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 返回定义和所有同名裸标识符引用。
    provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
    ): vscode.Location[] {
        const analysis = this.cache.get(document);
        const token = tokenAt(analysis, document.offsetAt(position));
        if (!token) {
            return [];
        }
        const locations = analysis.references
            .filter(reference => reference.text === token.text)
            .map(reference => new vscode.Location(document.uri, tokenRange(document, reference)));
        if (context.includeDeclaration) {
            locations.push(...analysis.definitions
                .filter(definition => definition.name === token.text)
                .map(definition => new vscode.Location(document.uri, tokenRange(document, definition.token))));
        }
        return locations;
    }
}

/// 对变量定义及其引用执行文档内重命名。
class RenameProvider implements vscode.RenameProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 校验新标识符并生成同名 token 的替换编辑。
    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
    ): vscode.WorkspaceEdit {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
            throw new Error('RDSL 变量名只能包含字母、数字和下划线，且不能以数字开头');
        }
        const analysis = this.cache.get(document);
        const token = tokenAt(analysis, document.offsetAt(position));
        if (!token) {
            throw new Error('当前位置不是可重命名的 RDSL 变量');
        }
        const edit = new vscode.WorkspaceEdit();
        const tokens = [
            ...analysis.definitions.filter(value => value.name === token.text).map(value => value.token),
            ...analysis.references.filter(value => value.text === token.text),
        ];
        for (const value of tokens) {
            edit.replace(document.uri, tokenRange(document, value), newName);
        }
        return edit;
    }
}

/// 在文档大纲中显示变量、循环和请求调用。
class DocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 构造扁平但稳定的 RDSL 文档符号列表。
    provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const analysis = this.cache.get(document);
        const symbols = analysis.definitions.map(definition => {
            const range = tokenRange(document, definition.token);
            return new vscode.DocumentSymbol(
                definition.name,
                definition.valueType ?? 'variable',
                vscode.SymbolKind.Variable,
                range,
                range,
            );
        });
        symbols.push(...analysis.calls.map(call => {
            const range = new vscode.Range(document.positionAt(call.start), document.positionAt(call.end));
            const tag = call.args.find(arg => arg.name === 'tag')?.valueTokens[0]?.text ?? '';
            return new vscode.DocumentSymbol(call.name, tag, vscode.SymbolKind.Function, range, tokenRange(document, call.nameToken));
        }));
        return symbols.sort((lhs, rhs) => lhs.range.start.compareTo(rhs.range.start));
    }
}

/// 根据花括号生成循环折叠范围。
class FoldingProvider implements vscode.FoldingRangeProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 配对文档中的花括号并返回多行范围。
    provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        const stack: number[] = [];
        const ranges: vscode.FoldingRange[] = [];
        for (const token of this.cache.get(document).tokens) {
            if (token.text === '{') {
                stack.push(document.positionAt(token.start).line);
            } else if (token.text === '}') {
                const start = stack.pop();
                const end = document.positionAt(token.end).line;
                if (start !== undefined && end > start) {
                    ranges.push(new vscode.FoldingRange(start, end));
                }
            }
        }
        return ranges;
    }
}

/// 为指令、具名参数和变量提供上下文语义 token。
class SemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    constructor(private readonly cache: AnalysisCache) {}

    /// 构造按源码位置排序且不重叠的语义 token。
    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
        const analysis = this.cache.get(document);
        const classified = new Map<number, {token: {start: number, end: number}, type: number}>();
        for (const call of analysis.calls) {
            classified.set(call.nameToken.start, {token: call.nameToken, type: 0});
            for (const arg of call.args) {
                classified.set(arg.nameToken.start, {token: arg.nameToken, type: 1});
            }
        }
        for (const definition of analysis.definitions) {
            classified.set(definition.token.start, {token: definition.token, type: 2});
        }
        for (const reference of analysis.references) {
            classified.set(reference.start, {token: reference, type: 2});
        }
        const builder = new vscode.SemanticTokensBuilder(semanticLegend);
        for (const value of [...classified.values()].sort((lhs, rhs) => lhs.token.start - rhs.token.start)) {
            const start = document.positionAt(value.token.start);
            const end = document.positionAt(value.token.end);
            if (start.line === end.line) {
                builder.push(start.line, start.character, end.character - start.character, value.type, 0);
            }
        }
        return builder.build();
    }
}

/// 对 RDSL 进行仅调整缩进和行尾空白的保守格式化。
class FormattingProvider implements vscode.DocumentFormattingEditProvider {
    /// 按花括号层级生成完整文档替换编辑。
    provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions): vscode.TextEdit[] {
        const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
        let depth = 0;
        const lines: string[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text.trim();
            if (text.startsWith('}')) {
                depth = Math.max(0, depth - 1);
            }
            lines.push(text.length === 0 ? '' : unit.repeat(depth) + text);
            if (text.endsWith('{')) {
                depth++;
            }
        }
        const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        return [vscode.TextEdit.replace(range, lines.join('\n'))];
    }
}

/// 把纯 offset token 转换为 VS Code Range。
function tokenRange(document: vscode.TextDocument, token: {start: number, end: number}): vscode.Range {
    return new vscode.Range(document.positionAt(token.start), document.positionAt(token.end));
}
