import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.RDSL_SCHEMA_SOURCE
    ? path.resolve(process.env.RDSL_SCHEMA_SOURCE)
    : path.resolve(root, '..', 'simulator', 'rdsl-schema.json');
const target = path.resolve(root, 'schemas', 'rdsl-schema.json');
const checkOnly = process.argv.includes('--check');

// simulator schema 是唯一来源；独立构建插件时允许使用已提交的有效快照。
if (fs.existsSync(source)) {
    const sourceText = fs.readFileSync(source, 'utf8');
    if (checkOnly) {
        const targetText = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
        if (sourceText !== targetText) {
            throw new Error(`RDSL schema snapshot is stale. Run: npm run sync-schema`);
        }
    } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }
}

if (!fs.existsSync(target)) {
    throw new Error(`Missing bundled RDSL schema: ${target}`);
}
const schema = JSON.parse(fs.readFileSync(target, 'utf8'));
if (!Number.isInteger(schema.schema_version) || !Array.isArray(schema.instructions)) {
    throw new Error('Bundled RDSL schema has an invalid shape');
}
