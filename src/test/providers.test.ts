import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

/// 在真实扩展宿主中打开 RDSL 文档，并通过 VS Code 命令调用补全提供者。
async function completions(source: string): Promise<vscode.CompletionList> {
    const document = await vscode.workspace.openTextDocument({language: 'rdsl', content: source});
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', document.uri, document.positionAt(source.length),
    );
    assert.ok(result, 'RDSL completion provider must return a result');
    return result;
}

/// 兼容字符串和结构化标签形式的补全项。
function completionLabel(item: vscode.CompletionItem): string {
    return typeof item.label === 'string' ? item.label : item.label.label;
}

suite('RDSL VS Code providers', () => {
    suiteSetup(async function () {
        this.timeout(10000);
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const extension = vscode.extensions.all.find(value => value.extensionPath === extensionRoot);
        assert.ok(extension, 'RDSL extension must be loaded in the extension host');
        await extension.activate();
        assert.ok(extension.isActive);
    });

    test('completion exposes transpose, fusion, packing and solver instructions', async () => {
        const result = await completions('');
        const names = new Set(result.items.map(completionLabel));
        for (const name of [
            'CTrfTile', 'CTrfTileD', 'GFusedApplyRow', 'GFusedBinaryTile', 'GFusedElemTile',
            'GPackApplyRow', 'GPackBinaryTile', 'GPackElemTile', 'GMatMulTail', 'GTrace', 'GElemTile',
        ]) {
            assert.ok(names.has(name), `${name} must be offered by the completion provider`);
        }
    });

    test('instruction snippets omit optional alpha while argument completion exposes it', async () => {
        const result = await completions('');
        const instruction = result.items.find(item => completionLabel(item) === 'GElemTile');
        assert.ok(instruction);
        assert.ok(instruction.insertText instanceof vscode.SnippetString);
        assert.ok(instruction.insertText.value.includes('gpe_rows ='));
        assert.ok(!instruction.insertText.value.includes('alpha ='));

        const argumentsResult = await completions('GElemTile(tag = "scale", ');
        const alpha = argumentsResult.items.find(item => completionLabel(item) === 'alpha');
        assert.ok(alpha);
        assert.strictEqual(alpha.detail, 'float (optional)');
        assert.ok(!argumentsResult.items.some(item => completionLabel(item) === 'tag'));
    });

    test('signature help maps reordered named arguments to schema positions', async () => {
        const source = 'GElemTile(alpha = -0.5, gpe_rows = 1, op = "Scale", tag = "scale", rq = [], '
            + 'from = "A", from_tile = [0, 1, 0, 1], to = "B", to_tile = [0, 1, 0, 1]);';
        const document = await vscode.workspace.openTextDocument({language: 'rdsl', content: source});
        for (const [value, expectedName, expectedIndex] of [
            ['-0.5', 'alpha', 8], ['"Scale"', 'op', 2], ['"scale"', 'tag', 0],
        ] as const) {
            const position = document.positionAt(source.indexOf(value) + value.length);
            const result = await vscode.commands.executeCommand<vscode.SignatureHelp>(
                'vscode.executeSignatureHelpProvider', document.uri, position,
            );
            assert.ok(result);
            assert.strictEqual(result.activeParameter, expectedIndex);
            assert.strictEqual(result.signatures[0].parameters[result.activeParameter].label, expectedName);
        }
    });

    test('diagnostics accept negative alpha and Reciprocal through GElemTile', async () => {
        const source = 'GElemTile(tag = "scale", rq = [], op = "Scale", from = "A", '
            + 'from_tile = [0, 1, 0, 1], to = "B", to_tile = [0, 1, 0, 1], gpe_rows = 1, alpha = -0.5);\n'
            + 'GElemTile(tag = "inverse", rq = ["scale"], op = "Reciprocal", from = "B", '
            + 'from_tile = [0, 1, 0, 1], to = "C", to_tile = [0, 1, 0, 1], gpe_rows = 1);';
        const invalid = await vscode.workspace.openTextDocument({language: 'rdsl', content: 'UnknownInstruction();'});
        const valid = await vscode.workspace.openTextDocument({language: 'rdsl', content: source});
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.ok(vscode.languages.getDiagnostics(invalid.uri).some(diagnostic => diagnostic.source === 'rdsl'));
        assert.deepStrictEqual(vscode.languages.getDiagnostics(valid.uri).filter(diagnostic => diagnostic.source === 'rdsl'), []);
    });
});
