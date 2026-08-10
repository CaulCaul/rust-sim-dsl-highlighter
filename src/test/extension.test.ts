import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeRDSL, RDSLSchema, tokenizeRDSL } from '../language';

/// 从扩展根目录读取测试使用的 schema 快照。
function schema(): RDSLSchema {
    const filename = path.resolve(__dirname, '..', '..', 'schemas', 'rdsl-schema.json');
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as RDSLSchema;
}

suite('RDSL language support', () => {
    test('schema covers the simulator instruction surface', () => {
        const value = schema();
        assert.strictEqual(value.schema_version, 1);
        assert.strictEqual(value.instructions.length, 36);
        assert.ok(value.instructions.some(instruction => instruction.name === 'GSparseEdgeScoreRow'));
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
