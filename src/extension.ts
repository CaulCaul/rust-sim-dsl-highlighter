import * as vscode from 'vscode';

// ==========================================
// 1. 指令定义 (模拟 Rust 结构体函数签名)
// 在这里维护你的指令列表和参数名
// ==========================================
interface InstructionSignature {
    name: string;
    params: string[]; // 参数名列表，如 ['a', 'b']
}

const INSTRUCTIONS: Record<string, InstructionSignature> = {
    'CAddMatrix': {name:'CAddMatrix', params:['name', 'rq', 'matrix_name', 'file_path', 'fmt', 'sparse', 'file_sparse']},
    'CNewMatrix': {name:'CNewMatrix', params:['name', 'rq', 'matrix_name', 'shape', 'fmt']},
    'SLoadTile': {name:'SLoadTile', params:['name', 'rq', 'matrix_name', 'tile']},
    'CLoadTile': {name:'CLoadTile', params:['name', 'rq', 'matrix_name', 'tile']},
    'SSaveTile': {name:'SSaveTile', params:['name', 'rq', 'matrix_name', 'tile']},
    'SDropTile': {name:'SDropTile', params:['name', 'rq', 'matrix_name', 'tile']},
    'CCvtTileD': {name:'CCvtTileD', params:['name', 'rq', 'from_matrix', 'from_tile', 'to_matrix', 'to_tile']},
    'CTrfTileD': {name:'CTrfTileD', params:['name', 'rq', 'from_matrix', 'from_tile', 'to_matrix', 'to_tile']},
    'PInpdTile': {name:'PInpdTile', params:['name', 'rq', 'op1_name', 'op1_tile', 'op2_name', 'op2_tile', 'pe_row_num']},
    'MInpdTile': {name:'MInpdTile', params:['name', 'rq', 'from_request', 'rst_matrix', 'rst_tile', 'mt_num']},
    'PTripTile': {name:'PTripTile', params:['name', 'rq', 'op1_name', 'op1_tile', 'op2_name', 'op2_tile', 'pe_row_num']},
    'MTripTile': {name:'MTripTile', params:['name', 'rq', 'from_request', 'rst_matrix', 'rst_tile', 'mt_num']},
    'PTrgtTile': {name:'PTrgtTile', params:['name', 'rq', 'op1_name', 'op1_tile', 'op2_name', 'op2_tile', 'pe_row_num']},
    'MTrgtTile': {name:'MTrgtTile', params:['name', 'rq', 'from_request', 'rst_matrix', 'rst_tile', 'mt_num']},
    'PTrgsTile': {name:'PTrgsTile', params:['name', 'rq', 'op1_name', 'op1_tile', 'op2_name', 'op2_tile', 'pe_row_num']},
    'MTrgsTile': {name:'MTrgsTile', params:['name', 'rq', 'from_request', 'rst_matrix', 'rst_tile', 'mt_num']},
    'GApplyRow': {name:'GApplyRow', params:['name', 'rq', 'op', 'op1_name', 'op1_tile', 'op2_name', 'op2_tile',     'rst_name', 'rst_tile', 'gpe_row_num']},
    'GElemTile': {name:'GElemTile', params:['name', 'rq', 'op', 'from_matrix', 'from_tile', 'to_matrix', 'to_tile', 'gpe_row_num']},
    'XExit': {name:'XExit', params:['rq']},
    'XPrint': {name:'XPrint', params:['rq', 'text']},
    'XPrintTile': {name:'XPrintTile', params:['rq', 'matrix_name', 'tile', 'sparse']},
    // 添加更多指令...
    // 'my_custom_cmd': { name: 'my_custom_cmd', params: ['arg1', 'arg2', 'flag'] }
};

// ==========================================
// 2. 插件激活入口
// ==========================================
export function activate(context: vscode.ExtensionContext) {
    console.log('RDSL Highlighter is now active!');

    // 注册 Inlay Hints Provider
    const provider = vscode.languages.registerInlayHintsProvider(
        { language: 'rdsl' },
        new RDSLInlayHintsProvider()
    );

    context.subscriptions.push(provider);
}

export function deactivate() {}

// ==========================================
// 3. Inlay Hints 实现逻辑
// ==========================================
class RDSLInlayHintsProvider implements vscode.InlayHintsProvider {
    
    // 提示类型：参数名
    readonly kind = vscode.InlayHintKind.Parameter;

    async provideInlayHints(
        document: vscode.TextDocument, 
        range: vscode.Range, 
        token: vscode.CancellationToken
    ): Promise<vscode.InlayHint[]> {
        
        const hints: vscode.InlayHint[] = [];
        
        // 检查用户是否启用了该功能
        const config = vscode.workspace.getConfiguration('rdsl');
        if (!config.get<boolean>('inlayHints.enable', true)) {
            return hints;
        }

        // 逐行处理范围内的文本
        // 为了性能，通常只处理可见范围，这里简单处理整个文档或当前范围
        for (let lineNum = range.start.line; lineNum <= range.end.line; lineNum++) {
            const line = document.lineAt(lineNum);
            const text = line.text.trim();

            if (text.length === 0 || text.startsWith('#') || text.startsWith('//')) {
                continue;
            }

            // 解析行：提取指令名和参数
            // 简单的分词逻辑：按空格分割，但要考虑引号内的空格（这里简化处理，假设参数不含空格或已用引号包裹）
            // 更健壮的分词可能需要正则，这里用 split 演示逻辑
            const tokens = this.tokenizeLine(text);
            
            if (tokens.length === 0) continue;

            const commandName = tokens[0];
            const signature = INSTRUCTIONS[commandName];

            // 如果是指令且有定义的参数
            if (signature) {
                const args = tokens.slice(1); // 去掉指令名
                
                // 遍历参数，生成 Hint
                args.forEach((argToken, index) => {
                    // 如果参数数量超过了定义的参数名列表，最后一个参数名可以重复使用或显示 "..."
                    let paramName = signature.params[index];
                    if (!paramName && signature.params.length > 0) {
                        // 如果参数过多，复用最后一个名字，或者标记为 extra
                        paramName = signature.params[signature.params.length - 1]; 
                        if (index >= signature.params.length) {
                             paramName = `extra_${index - signature.params.length + 1}`;
                        }
                    } else if (!paramName) {
                        paramName = `arg${index + 1}`;
                    }

                    // 获取参数在原文本中的位置
                    // 我们需要找到这个 token 在原始字符串中的起始位置
                    const argPos = this.getTokenPosition(line.text, argToken, index);
                    
                    if (argPos) {
                        const hint = new vscode.InlayHint(
                            new vscode.Position(lineNum, argPos.end), // 提示显示在参数值的后面
                            ` ${paramName}: `, // 显示的文本，前面加空格美观
                            this.kind
                        );
                        
                        // 样式优化
                        hint.paddingLeft = true;
                        hint.paddingRight = false;
                        
                        // 可选：让提示看起来更像 rust-analyzer (灰色)
                        // VS Code 默认会根据 Kind 自动着色，也可以自定义
                        hints.push(hint);
                    }
                });
            }
        }

        return hints;
    }

    // 简单的分词器：处理空格分隔，基本处理引号
    private tokenizeLine(text: string): string[] {
        const tokens: string[] = [];
        let currentToken = '';
        let inQuotes = false;
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            if (char === '"' && (i === 0 || text[i-1] !== '\\')) {
                inQuotes = !inQuotes;
                currentToken += char;
            } else if (char === ' ' && !inQuotes) {
                if (currentToken.length > 0) {
                    tokens.push(currentToken);
                    currentToken = '';
                }
            } else {
                currentToken += char;
            }
        }
        if (currentToken.length > 0) {
            tokens.push(currentToken);
        }
        return tokens;
    }

    // 查找特定索引的 token 在原始行中的结束位置
    private getTokenPosition(lineText: string, targetToken: string, tokenIndex: number): { start: number, end: number } | null {
        const tokens = this.tokenizeLine(lineText);
        if (tokenIndex >= tokens.length) return null;

        // 重新扫描以获取精确位置
        let currentTokenIndex = 0;
        let currentToken = '';
        let inQuotes = false;
        let tokenStart = -1;

        for (let i = 0; i <= lineText.length; i++) {
            const char = i < lineText.length ? lineText[i] : ' '; // 末尾补空格触发最后一个 token

            if (char === '"' && (i === 0 || lineText[i-1] !== '\\')) {
                if (!inQuotes) tokenStart = i;
                inQuotes = !inQuotes;
                currentToken += char;
            } else if (char === ' ' && !inQuotes) {
                if (currentToken.length > 0) {
                    if (currentTokenIndex === tokenIndex) {
                        return { start: tokenStart, end: i };
                    }
                    currentTokenIndex++;
                    currentToken = '';
                    tokenStart = -1;
                }
            } else {
                if (tokenStart === -1 && !inQuotes && char !== ' ') tokenStart = i;
                currentToken += char;
            }
        }
        return null;
    }
}