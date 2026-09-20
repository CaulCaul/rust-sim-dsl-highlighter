import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/// 描述本测试读取的 TextMate 正则规则，保留字符串内部的嵌套规则。
interface GrammarRule {
    match?: string;
    begin?: string;
    end?: string;
    patterns?: GrammarRule[];
}

const grammar = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'syntaxes', 'rdsl.tmLanguage.json'),
    'utf8',
)) as { repository: Record<string, { patterns: GrammarRule[] }> };

/// 编译 JSON 解码后的规则，避免双重转义使 TextMate 模式静默失效。
function pattern(section: string, index = 0): RegExp {
    return new RegExp(grammar.repository[section].patterns[index].match!);
}

suite('RDSL TextMate grammar', () => {
    test('declarations, instructions and builtins match current structured syntax', () => {
        assert.deepStrictEqual(pattern('declarations').exec('let tile_rows = 128;')?.slice(1), ['let', 'tile_rows']);
        assert.deepStrictEqual(pattern('declarations').exec('for row in range(0, rows) {')?.slice(1), ['for', 'row']);
        for (const instruction of ['CNewMatrix(', 'CTrfTile (', 'XBarrier(']) {
            assert.ok(pattern('instructions').test(instruction));
        }
        for (const builtin of ['range', 'min', 'max', 'ceil_div']) {
            assert.strictEqual(pattern('builtins').exec(`${builtin} (0, rows)`)?.[0], builtin);
        }
        assert.strictEqual(pattern('builtins').exec('my_min(0, rows)'), null);
    });

    test('parameter highlighting distinguishes assignment from equality', () => {
        assert.strictEqual(pattern('parameters').exec('matrix = "A"')?.[0], 'matrix');
        for (const expression of ['row == 1', 'row != 1', 'row <= 1', 'row >= 1']) {
            assert.strictEqual(pattern('parameters').exec(expression), null);
        }
    });

    test('numbers use ASCII digits and preserve decimal and exponent literals', () => {
        const numeric = pattern('numbers');
        for (const literal of ['0', '128', '0.25', '1e-6', '2E+3', '3.125e2']) {
            assert.strictEqual(numeric.exec(literal)?.[0], literal);
        }
        assert.strictEqual(numeric.exec('tensor123'), null);
        assert.strictEqual(numeric.exec('１２３'), null);
        assert.strictEqual(numeric.exec('١٢٣'), null);
    });

    test('strings recognize the simulator escape set and scalar interpolation', () => {
        const rules = grammar.repository.strings.patterns[0].patterns!;
        const escape = new RegExp(rules[0].match!);
        for (const suffix of ['n', 'r', 't', '"', '\\']) {
            const text = '\\' + suffix;
            assert.strictEqual(escape.exec(text)?.[0], text);
        }
        for (const text of ['\\q', '\\0', '\\u1234']) {
            assert.strictEqual(escape.exec(text), null);
        }
        const interpolation = new RegExp(rules[1].match!);
        assert.deepStrictEqual(interpolation.exec('tile_${tile_row}')?.slice(1), ['${', 'tile_row', '}']);
        for (const text of ['${}', '${1row}', '${row + 1}']) {
            assert.strictEqual(interpolation.exec(text), null);
        }
    });

    test('comments and boolean operators remain supported by the interpreter', () => {
        for (const source of ['# comment', '// comment']) {
            assert.strictEqual(pattern('comments').exec(source)?.[0], source);
        }
        const operator = pattern('operators');
        for (const text of ['==', '!=', '<=', '>=', '&&', '||', '=', '+', '-', '*', '/', '%', '!', '<', '>']) {
            assert.strictEqual(operator.exec(text)?.[0], text);
        }
        assert.strictEqual(operator.exec('&'), null);
        assert.strictEqual(operator.exec('|'), null);
    });
});
