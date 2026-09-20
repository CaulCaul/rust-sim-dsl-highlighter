import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeRDSL, callAt, RDSLSchema, tokenizeRDSL } from '../language';

/// 从扩展根目录读取测试使用的 schema 快照。
function schema(): RDSLSchema {
    const filename = path.resolve(__dirname, '..', '..', 'schemas', 'rdsl-schema.json');
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as RDSLSchema;
}

suite('RDSL language support', () => {
    test('schema covers the simulator instruction surface', () => {
        const value = schema();
        assert.strictEqual(value.schema_version, 1);
        const names = value.instructions.map(instruction => instruction.name);
        assert.strictEqual(new Set(names).size, names.length);
        for (const name of ['GSparseEdgeScoreRow', 'CTrfTile', 'CTrfTileD',
            'GPackApplyRow', 'GPackBinaryTile', 'GPackElemTile', 'GFusedApplyRow',
            'GFusedBinaryTile', 'GFusedElemTile', 'GMatMulTail', 'GTrace', 'GSp2UpdateTile']) {
            assert.ok(names.includes(name), name);
        }
        const simulatorSchema = path.resolve(__dirname, '../../../simulator/rdsl-schema.json');
        if (fs.existsSync(simulatorSchema)) {
            assert.deepStrictEqual(value, JSON.parse(fs.readFileSync(simulatorSchema, 'utf8')));
        }
    });

    test('every schema instruction accepts its complete named interface', () => {
        const value = schema();
        const calls = value.instructions.map((instruction, index) => {
            const args = instruction.params.filter(param => !param.optional).map(param => {
                const literal = param.name === 'tag' ? `"call_${index}"`
                    : ['from_request', 'storage_request'].includes(param.name) ? '"seed"'
                    : param.type === 'string' ? '"matrix"'
                    : param.type === 'bool' ? 'false'
                    : param.type.endsWith('_list') ? '[]' : '1';
                return `${param.name} = ${literal}`;
            });
            return `${instruction.name}(${args.join(', ')});`;
        });
        const analysis = analyzeRDSL('XBarrier(tag = "seed", rq = []);\n' + calls.join('\n'), value);
        assert.deepStrictEqual(analysis.issues, []);
        assert.strictEqual(analysis.calls.length, value.instructions.length + 1);
    });

    test('negative float parameters and complete constant expressions are accepted', () => {
        const source = `
            GElemTile(tag = "scale", rq = [], op = "Scale", from = "A", from_tile = [0, 8, 0, 4],
                to = "B", to_tile = [0, 8, 0, 4], gpe_rows = (2 + 2), alpha = -1.0);
            XPrintTile(rq = ["scale"], matrix = "B", tile = [0, 8, 0, 4], sparse = 1 < 2);
        `;
        assert.deepStrictEqual(analyzeRDSL(source, schema()).issues, []);
    });

    test('incomplete calls include trailing whitespace and the final argument token', () => {
        for (const source of ['GElemTile(tag = "scale", ', 'GElemTile(tag = "scale", alpha = -0.5  ']) {
            const analysis = analyzeRDSL(source, schema());
            const call = callAt(analysis, source.length);
            assert.strictEqual(call?.name, 'GElemTile');
            assert.strictEqual(call?.args[0].valueTokens[0].text, '"scale"');
            if (source.includes('alpha')) {
                assert.strictEqual(call?.args[1].valueTokens.at(-1)?.text, '0.5');
            }
        }
    });

    test('constant expression types respect the named parameter schema', () => {
        const invalid = analyzeRDSL(
            'XPrintTile(rq = [1], matrix = true, tile = ["row"], sparse = (1 + 2));', schema(),
        );
        for (const name of ['rq', 'matrix', 'tile', 'sparse']) {
            assert.ok(invalid.issues.some(issue => issue.message.includes(`参数 \`${name}\` 需要`)), name);
        }
    });

    test('request flow distinguishes usize, float division and typed equality', () => {
        const source = `
            let integer = 9 / 2;
            let floating = 9.0 / 2.0;
            let equal = 1 == 1.0;
            let arrays = [1, 2] == [1, 2];
            XBarrier(tag = "i_\${integer}", rq = []);
            XBarrier(tag = "f_\${floating}", rq = ["i_4"]);
            XBarrier(tag = "eq_\${equal}_\${arrays}", rq = ["f_4.5"]);
            XBarrier(tag = "done", rq = ["eq_false_true"]);
        `;
        assert.deepStrictEqual(analyzeRDSL(source, schema()).issues, []);
    });

    test('usize tags preserve precision above the JavaScript safe integer range', () => {
        const source = `
            for i in range(9007199254740992, 9007199254740994) {
                XBarrier(tag = "b_\${i}", rq = []);
            }
            XBarrier(tag = "done", rq = ["b_9007199254740992", "b_9007199254740993"]);
        `;
        assert.deepStrictEqual(analyzeRDSL(source, schema()).issues, []);
    });

    test('trailing commas remain valid in arrays, builtins and range', () => {
        const source = `
            let count = ceil_div(3, 2,);
            for i in range(0, count,) { XBarrier(tag = "b_\${i}", rq = [],); }
            XBarrier(tag = "done", rq = ["b_0", "b_1",]);
        `;
        assert.deepStrictEqual(analyzeRDSL(source, schema()).issues, []);
    });

    test('escaped backslashes are decoded once when checking request tags', () => {
        const source = String.raw`
            XBarrier(tag = "\\n", rq = []);
            XBarrier(tag = "\n", rq = []);
            XBarrier(tag = "done", rq = ["\\n", "\n"]);
        `;
        assert.deepStrictEqual(analyzeRDSL(source, schema()).issues, []);
    });

    test('invalid escapes, exponents and out-of-range numbers are diagnosed', () => {
        for (const source of [String.raw`let x = "\q";`, 'let x = 1e+;', 'let x = 1e999;',
            'let x = 18446744073709551616;']) {
            assert.ok(tokenizeRDSL(source).issues.some(issue => issue.severity === 'error'), source);
        }
    });

    test('unknown float tag formatting does not produce false missing dependencies', () => {
        const source = `let x = 1e-8; XBarrier(tag = "b_\${x}", rq = []);
            XBarrier(tag = "done", rq = ["b_0.00000001"]);`;
        assert.deepStrictEqual(analyzeRDSL(source, schema()).issues, []);
    });

    test('request-valued arguments require an earlier request definition', () => {
        const analysis = analyzeRDSL('MInpdTile(tag = "merge", rq = [], from_request = "missing",'
            + 'out = "C", out_tile = [0, 8, 0, 8], mt_num = 1);', schema());
        assert.ok(analysis.issues.some(issue => issue.message.includes('request `missing` 尚未定义')));
    });

    test('structured loop and named calls have no diagnostics', () => {
        const source = `
            let rows = 5;
            CNewMatrix(tag = "init_A", rq = [], matrix = "A", shape = [rows, 4], fmt = "RDense");
            for row in range(0, rows, 2) {
                CLoadTile(tag = "load_\${row}", rq = ["init_A"], matrix = "A", tile = [row, min(row + 2, rows), 0, 4]);
            }
        `;
        const analysis = analyzeRDSL(source, schema());
        assert.deepStrictEqual(analysis.issues, []);
        assert.strictEqual(analysis.calls.length, 2);
        assert.strictEqual(analysis.definitions.length, 2);
    });

    test('loop-generated request tags satisfy later static dependencies', () => {
        const source = `
            for head in range(0, 4) {
                CNewMatrix(tag = "init_w_\${head}", rq = [], matrix = "w_\${head}", shape = [8, 8], fmt = "RDense");
            }
            SLoadTile(tag = "load", rq = ["init_w_0", "init_w_3"], matrix = "w_0", tile = [0, 8, 0, 8]);
        `;
        assert.deepStrictEqual(analyzeRDSL(source, schema()).issues, []);
    });

    test('nested loops preserve request definition order', () => {
        const source = `
            for outer in range(0, 2) {
                for inner in range(0, 2) {
                    XBarrier(tag = "barrier_\${outer}_\${inner}", rq = []);
                }
            }
            XBarrier(tag = "done", rq = ["barrier_1_1"]);
        `;
        assert.deepStrictEqual(analyzeRDSL(source, schema()).issues, []);
    });

    test('missing expanded requests and duplicate dynamic tags are diagnosed', () => {
        const missing = analyzeRDSL(
            'for i in range(0, 2) { XBarrier(tag = "b_${i}", rq = []); } XBarrier(tag = "done", rq = ["b_2"]);',
            schema(),
        );
        assert.ok(missing.issues.some(issue => issue.message.includes('b_2') && issue.message.includes('尚未定义')));
        const duplicate = analyzeRDSL(
            'for i in range(0, 2) { XBarrier(tag = "same", rq = []); }',
            schema(),
        );
        assert.ok(duplicate.issues.some(issue => issue.message.includes('重复定义')));
    });

    test('oversized loops disable request diagnostics within a fixed budget', () => {
        const source = `
            for i in range(0, 1000000000) {
                XBarrier(tag = "huge_\${i}", rq = []);
            }
            XBarrier(tag = "done", rq = ["missing"]);
        `;
        const analysis = analyzeRDSL(source, schema());
        assert.ok(!analysis.issues.some(issue => issue.message.includes('request `')));
    });

    test('unknown and missing named arguments are diagnosed', () => {
        const analysis = analyzeRDSL(
            'CLoadTile(tag = "load", rq = [], unknown = 1);',
            schema(),
        );
        assert.ok(analysis.issues.some(issue => issue.message.includes('没有参数')));
        assert.ok(analysis.issues.some(issue => issue.message.includes('缺少必需参数')));
    });

    test('lexer preserves arrays, expressions and quoted paths', () => {
        const lexical = tokenizeRDSL('let x = [min(2 + 3, 8), 4]; // path "a b"');
        assert.deepStrictEqual(lexical.issues, []);
        assert.ok(lexical.tokens.some(token => token.kind === 'comment'));
        assert.ok(lexical.tokens.some(token => token.text === 'min'));
    });
});
