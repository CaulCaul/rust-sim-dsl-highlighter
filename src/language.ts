export interface ParameterSpec {
    name: string;
    type: 'int' | 'float' | 'string' | 'bool' | 'int_list' | 'string_list';
    optional?: boolean;
    default?: unknown;
}

export interface InstructionSpec {
    name: string;
    doc: string;
    params: ParameterSpec[];
}

export interface RDSLSchema {
    schema_version: number;
    instructions: InstructionSpec[];
}

export type TokenKind = 'identifier' | 'number' | 'string' | 'symbol' | 'comment' | 'unknown';

export interface RDSLToken {
    kind: TokenKind;
    text: string;
    start: number;
    end: number;
}

export interface DiagnosticIssue {
    start: number;
    end: number;
    message: string;
    severity: 'error' | 'warning';
}

export interface NamedArgument {
    name: string;
    nameToken: RDSLToken;
    valueTokens: RDSLToken[];
}

export interface InstructionCall {
    name: string;
    nameToken: RDSLToken;
    start: number;
    end: number;
    args: NamedArgument[];
    spec?: InstructionSpec;
}

export interface VariableDefinition {
    name: string;
    token: RDSLToken;
    valueType?: string;
}

export interface RDSLAnalysis {
    tokens: RDSLToken[];
    calls: InstructionCall[];
    definitions: VariableDefinition[];
    references: RDSLToken[];
    issues: DiagnosticIssue[];
}

const KEYWORDS = new Set(['let', 'for', 'in', 'true', 'false']);
const BUILTINS = new Set(['range', 'min', 'max', 'ceil_div']);
const OPEN_TO_CLOSE: Record<string, string> = {'(': ')', '[': ']', '{': '}'};
const CLOSE = new Set(Object.values(OPEN_TO_CLOSE));
const REQUEST_FLOW_BUDGET = 20_000;
const UNKNOWN_VALUE = Symbol('unknown RDSL value');

type FlowValue = number | string | boolean | number[] | string[];
type FlowBinding = FlowValue | typeof UNKNOWN_VALUE;

interface RequestFlowState {
    defined: Set<string>;
    issues: DiagnosticIssue[];
    issueKeys: Set<string>;
    operations: number;
}

/// 对完整文档执行容错词法分析，并报告字符串和未知字符问题。
export function tokenizeRDSL(text: string): {tokens: RDSLToken[], issues: DiagnosticIssue[]} {
    const tokens: RDSLToken[] = [];
    const issues: DiagnosticIssue[] = [];
    let index = 0;
    while (index < text.length) {
        const start = index;
        const char = text[index];
        if (/\s/.test(char)) {
            index++;
            continue;
        }
        if (char === '#' || (char === '/' && text[index + 1] === '/')) {
            while (index < text.length && text[index] !== '\n') {
                index++;
            }
            tokens.push({kind: 'comment', text: text.slice(start, index), start, end: index});
            continue;
        }
        if (char === '"') {
            index++;
            let closed = false;
            while (index < text.length) {
                if (text[index] === '\\') {
                    index += Math.min(2, text.length - index);
                } else if (text[index] === '"') {
                    index++;
                    closed = true;
                    break;
                } else {
                    index++;
                }
            }
            tokens.push({kind: 'string', text: text.slice(start, index), start, end: index});
            if (!closed) {
                issues.push({start, end: index, message: '字符串缺少结束引号', severity: 'error'});
            }
            continue;
        }
        if (/[A-Za-z_]/.test(char)) {
            index++;
            while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) {
                index++;
            }
            tokens.push({kind: 'identifier', text: text.slice(start, index), start, end: index});
            continue;
        }
        if (/[0-9]/.test(char)) {
            index++;
            while (index < text.length && /[0-9]/.test(text[index])) {
                index++;
            }
            if (text[index] === '.' && /[0-9]/.test(text[index + 1] ?? '')) {
                index++;
                while (index < text.length && /[0-9]/.test(text[index])) {
                    index++;
                }
            }
            if (text[index] === 'e' || text[index] === 'E') {
                index++;
                if (text[index] === '+' || text[index] === '-') {
                    index++;
                }
                while (index < text.length && /[0-9]/.test(text[index])) {
                    index++;
                }
            }
            tokens.push({kind: 'number', text: text.slice(start, index), start, end: index});
            continue;
        }
        const pair = text.slice(index, index + 2);
        if (['==', '!=', '<=', '>=', '&&', '||'].includes(pair)) {
            index += 2;
            tokens.push({kind: 'symbol', text: pair, start, end: index});
            continue;
        }
        if ('(){}[],;=+-*/%!<>'.includes(char)) {
            index++;
            tokens.push({kind: 'symbol', text: char, start, end: index});
            continue;
        }
        index++;
        tokens.push({kind: 'unknown', text: char, start, end: index});
        issues.push({start, end: index, message: `无法识别字符 \`${char}\``, severity: 'error'});
    }
    return {tokens, issues};
}

/// 基于共享 schema 分析指令、具名参数、变量和 request 依赖。
export function analyzeRDSL(text: string, schema: RDSLSchema): RDSLAnalysis {
    const lexical = tokenizeRDSL(text);
    const tokens = lexical.tokens.filter(token => token.kind !== 'comment');
    const issues = [...lexical.issues];
    validateBrackets(tokens, issues);
    const definitions = collectDefinitions(tokens);
    const calls = collectCalls(tokens, schema, issues);
    validateCalls(calls, issues);
    validateRequestDependencies(tokens, calls, issues);
    const references = collectReferences(tokens, calls, definitions);
    validateVariableReferences(references, definitions, issues);
    return {tokens: lexical.tokens, calls, definitions, references, issues};
}

/// 返回包含指定 offset 的 token。
export function tokenAt(analysis: RDSLAnalysis, offset: number): RDSLToken | undefined {
    return analysis.tokens.find(token => token.start <= offset && offset <= token.end);
}

/// 返回包含指定 offset 的指令调用。
export function callAt(analysis: RDSLAnalysis, offset: number): InstructionCall | undefined {
    return analysis.calls.find(call => call.start <= offset && offset <= call.end);
}

/// 检查括号类型和嵌套顺序。
function validateBrackets(tokens: RDSLToken[], issues: DiagnosticIssue[]): void {
    const stack: RDSLToken[] = [];
    for (const token of tokens) {
        if (OPEN_TO_CLOSE[token.text]) {
            stack.push(token);
        } else if (CLOSE.has(token.text)) {
            const open = stack.pop();
            if (!open || OPEN_TO_CLOSE[open.text] !== token.text) {
                issues.push({start: token.start, end: token.end, message: `不匹配的 \`${token.text}\``, severity: 'error'});
            }
        }
    }
    for (const token of stack) {
        issues.push({start: token.start, end: token.end, message: `\`${token.text}\` 缺少结束符`, severity: 'error'});
    }
}

/// 收集 let 和 for 创建的变量定义及可推导类型。
function collectDefinitions(tokens: RDSLToken[]): VariableDefinition[] {
    const definitions: VariableDefinition[] = [];
    for (let index = 0; index < tokens.length - 1; index++) {
        const token = tokens[index];
        if ((token.text === 'let' || token.text === 'for') && tokens[index + 1].kind === 'identifier') {
            const variable = tokens[index + 1];
            definitions.push({
                name: variable.text,
                token: variable,
                valueType: token.text === 'for' ? 'int' : inferDefinitionType(tokens, index + 2),
            });
        }
    }
    return definitions;
}

/// 从 let 等号后的首 token 推导编辑器显示类型。
function inferDefinitionType(tokens: RDSLToken[], start: number): string | undefined {
    let index = start;
    if (tokens[index]?.text === '=') {
        index++;
    }
    const token = tokens[index];
    if (!token) {
        return undefined;
    }
    if (token.kind === 'string') {
        return 'string';
    }
    if (token.kind === 'number') {
        return /[.eE]/.test(token.text) ? 'float' : 'int';
    }
    if (token.text === 'true' || token.text === 'false') {
        return 'bool';
    }
    if (token.text === '[') {
        return 'list';
    }
    return undefined;
}

/// 收集所有大写开头的指令调用和其顶层具名参数。
function collectCalls(tokens: RDSLToken[], schema: RDSLSchema, issues: DiagnosticIssue[]): InstructionCall[] {
    const specs = new Map(schema.instructions.map(spec => [spec.name, spec]));
    const calls: InstructionCall[] = [];
    for (let index = 0; index < tokens.length - 1; index++) {
        const nameToken = tokens[index];
        if (nameToken.kind !== 'identifier' || !/^[A-Z]/.test(nameToken.text) || tokens[index + 1].text !== '(') {
            continue;
        }
        const closeIndex = matchingClose(tokens, index + 1);
        const endIndex = closeIndex ?? tokens.length - 1;
        const args = collectNamedArguments(tokens, index + 2, endIndex);
        const call: InstructionCall = {
            name: nameToken.text,
            nameToken,
            start: nameToken.start,
            end: tokens[endIndex]?.end ?? nameToken.end,
            args,
            spec: specs.get(nameToken.text),
        };
        calls.push(call);
        if (!call.spec) {
            issues.push({start: nameToken.start, end: nameToken.end, message: `未知 RDSL 指令 \`${nameToken.text}\``, severity: 'error'});
        }
        if (closeIndex !== undefined) {
            index = closeIndex;
        }
    }
    return calls;
}

/// 返回一个左括号在 token 流中的匹配右括号位置。
function matchingClose(tokens: RDSLToken[], openIndex: number): number | undefined {
    const open = tokens[openIndex].text;
    const close = OPEN_TO_CLOSE[open];
    let depth = 0;
    for (let index = openIndex; index < tokens.length; index++) {
        if (tokens[index].text === open) {
            depth++;
        } else if (tokens[index].text === close) {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return undefined;
}

/// 收集一条指令中位于第一层括号内的具名参数。
function collectNamedArguments(tokens: RDSLToken[], start: number, end: number): NamedArgument[] {
    const args: NamedArgument[] = [];
    let index = start;
    let depth = 0;
    while (index < end) {
        const token = tokens[index];
        if (depth === 0 && token.kind === 'identifier' && tokens[index + 1]?.text === '=') {
            const valueStart = index + 2;
            let valueEnd = valueStart;
            let valueDepth = 0;
            while (valueEnd < end) {
                const text = tokens[valueEnd].text;
                if (OPEN_TO_CLOSE[text]) {
                    valueDepth++;
                } else if (CLOSE.has(text)) {
                    valueDepth--;
                } else if (text === ',' && valueDepth === 0) {
                    break;
                }
                valueEnd++;
            }
            args.push({name: token.text, nameToken: token, valueTokens: tokens.slice(valueStart, valueEnd)});
            index = valueEnd + 1;
            continue;
        }
        if (OPEN_TO_CLOSE[token.text]) {
            depth++;
        } else if (CLOSE.has(token.text)) {
            depth--;
        }
        index++;
    }
    return args;
}

/// 根据 schema 检查未知、重复、缺失参数和明显的字面量类型错误。
function validateCalls(calls: InstructionCall[], issues: DiagnosticIssue[]): void {
    for (const call of calls) {
        if (!call.spec) {
            continue;
        }
        const params = new Map(call.spec.params.map(param => [param.name, param]));
        const seen = new Set<string>();
        for (const arg of call.args) {
            const param = params.get(arg.name);
            if (!param) {
                issues.push({start: arg.nameToken.start, end: arg.nameToken.end, message: `\`${call.name}\` 没有参数 \`${arg.name}\``, severity: 'error'});
            } else if (seen.has(arg.name)) {
                issues.push({start: arg.nameToken.start, end: arg.nameToken.end, message: `参数 \`${arg.name}\` 重复赋值`, severity: 'error'});
            } else if (!literalMatchesType(arg.valueTokens, param.type)) {
                const first = arg.valueTokens[0] ?? arg.nameToken;
                const last = arg.valueTokens.at(-1) ?? first;
                issues.push({start: first.start, end: last.end, message: `参数 \`${arg.name}\` 需要 ${param.type}`, severity: 'error'});
            }
            seen.add(arg.name);
        }
        for (const param of call.spec.params) {
            if (!param.optional && !seen.has(param.name)) {
                issues.push({start: call.nameToken.start, end: call.nameToken.end, message: `缺少必需参数 \`${param.name}\``, severity: 'error'});
            }
        }
    }
}

/// 对可静态识别的字面量检查 schema 类型。
function literalMatchesType(tokens: RDSLToken[], expected: ParameterSpec['type']): boolean {
    const first = tokens[0];
    if (!first || first.kind === 'identifier') {
        return true;
    }
    if (expected === 'string') {
        return first.kind === 'string';
    }
    if (expected === 'bool') {
        return first.text === 'true' || first.text === 'false';
    }
    if (expected === 'int') {
        return first.kind === 'number' && !/[.eE]/.test(first.text);
    }
    if (expected === 'float') {
        return first.kind === 'number';
    }
    if (expected.endsWith('_list')) {
        return first.text === '[';
    }
    return true;
}

/// 按源码执行顺序检查 request tag；超出固定预算时静默跳过，避免大循环阻塞编辑器。
function validateRequestDependencies(tokens: RDSLToken[], calls: InstructionCall[], issues: DiagnosticIssue[]): void {
    const state: RequestFlowState = {
        defined: new Set(),
        issues: [],
        issueKeys: new Set(),
        operations: 0,
    };
    const callsByOffset = new Map(calls.map(call => [call.start, call]));
    const complete = executeRequestBlock(tokens, 0, tokens.length, new Map(), callsByOffset, state);
    if (complete) {
        issues.push(...state.issues);
    }
}

/// 在预算内执行一段轻量级 RDSL 控制流，只求值 let、for、tag 和 rq。
function executeRequestBlock(
    tokens: RDSLToken[],
    start: number,
    end: number,
    environment: Map<string, FlowBinding>,
    callsByOffset: Map<number, InstructionCall>,
    state: RequestFlowState,
): boolean {
    let index = start;
    while (index < end) {
        if (!consumeRequestFlowBudget(state)) {
            return false;
        }
        const token = tokens[index];
        if (token.text === 'let') {
            const name = tokens[index + 1];
            const equals = tokens[index + 2];
            const semicolon = findStatementEnd(tokens, index + 3, end);
            if (!name || name.kind !== 'identifier' || equals?.text !== '=' || semicolon === undefined) {
                return false;
            }
            environment.set(name.text, evaluateFlowExpression(tokens.slice(index + 3, semicolon), environment));
            index = semicolon + 1;
            continue;
        }
        if (token.text === 'for') {
            const variable = tokens[index + 1];
            const range = tokens[index + 3];
            const open = tokens[index + 4];
            if (variable?.kind !== 'identifier' || tokens[index + 2]?.text !== 'in'
                || range?.text !== 'range' || open?.text !== '(') {
                return false;
            }
            const rangeClose = matchingClose(tokens, index + 4);
            const bodyOpen = rangeClose === undefined ? undefined : rangeClose + 1;
            if (rangeClose === undefined || bodyOpen === undefined || tokens[bodyOpen]?.text !== '{') {
                return false;
            }
            const bodyClose = matchingClose(tokens, bodyOpen);
            if (bodyClose === undefined || bodyClose > end) {
                return false;
            }
            const rangeValues = splitTopLevel(tokens.slice(index + 5, rangeClose))
                .map(part => evaluateFlowExpression(part, environment));
            const bounds = requestRangeBounds(rangeValues);
            if (!bounds) {
                return false;
            }
            for (let value = bounds.start; value < bounds.end; value += bounds.step) {
                if (!consumeRequestFlowBudget(state)) {
                    return false;
                }
                const scope = new Map(environment);
                scope.set(variable.text, value);
                if (!executeRequestBlock(tokens, bodyOpen + 1, bodyClose, scope, callsByOffset, state)) {
                    return false;
                }
            }
            index = bodyClose + 1;
            continue;
        }
        const call = callsByOffset.get(token.start);
        if (call) {
            validateExpandedRequestCall(call, environment, state);
            while (index < end && tokens[index].start < call.end) {
                index++;
            }
            if (tokens[index]?.text === ';') {
                index++;
            }
            continue;
        }
        index++;
    }
    return true;
}

/// 对一条已经代入当前变量环境的指令检查依赖与 tag 唯一性。
function validateExpandedRequestCall(
    call: InstructionCall,
    environment: Map<string, FlowBinding>,
    state: RequestFlowState,
): void {
    const rq = call.args.find(arg => arg.name === 'rq');
    const requirements = rq && evaluateFlowExpression(rq.valueTokens, environment);
    if (rq && Array.isArray(requirements) && requirements.every(value => typeof value === 'string')) {
        const sourceTokens = rq.valueTokens.filter(token => token.kind === 'string');
        requirements.forEach((dependency, index) => {
            if (!state.defined.has(dependency)) {
                const source = sourceTokens[index] ?? rq.nameToken;
                addRequestFlowIssue(state, source, `request \`${dependency}\` 尚未定义`);
            }
        });
    }
    const tag = call.args.find(arg => arg.name === 'tag');
    const tagValue = tag && evaluateFlowExpression(tag.valueTokens, environment);
    if (tag && typeof tagValue === 'string') {
        const source = tag.valueTokens.find(token => token.kind === 'string') ?? tag.nameToken;
        if (state.defined.has(tagValue)) {
            addRequestFlowIssue(state, source, `request \`${tagValue}\` 重复定义`);
        }
        state.defined.add(tagValue);
    }
}

/// 在同一源码位置只记录一次循环展开诊断。
function addRequestFlowIssue(state: RequestFlowState, token: RDSLToken, message: string): void {
    const key = `${token.start}:${token.end}`;
    if (!state.issueKeys.has(key)) {
        state.issueKeys.add(key);
        state.issues.push({start: token.start, end: token.end, message, severity: 'error'});
    }
}

/// 消耗一次轻量控制流操作预算。
function consumeRequestFlowBudget(state: RequestFlowState): boolean {
    state.operations++;
    return state.operations <= REQUEST_FLOW_BUDGET;
}

/// 查找不在括号或数组内部的语句分号。
function findStatementEnd(tokens: RDSLToken[], start: number, end: number): number | undefined {
    let depth = 0;
    for (let index = start; index < end; index++) {
        const text = tokens[index].text;
        if (OPEN_TO_CLOSE[text]) {
            depth++;
        } else if (CLOSE.has(text)) {
            depth--;
        } else if (text === ';' && depth === 0) {
            return index;
        }
    }
    return undefined;
}

/// 按顶层逗号切分 range、数组或函数参数。
function splitTopLevel(tokens: RDSLToken[]): RDSLToken[][] {
    const result: RDSLToken[][] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < tokens.length; index++) {
        const text = tokens[index].text;
        if (OPEN_TO_CLOSE[text]) {
            depth++;
        } else if (CLOSE.has(text)) {
            depth--;
        } else if (text === ',' && depth === 0) {
            result.push(tokens.slice(start, index));
            start = index + 1;
        }
    }
    result.push(tokens.slice(start));
    return result;
}

/// 把已求值的 range 参数转换为安全的非负整数边界。
function requestRangeBounds(values: FlowBinding[]): {start: number, end: number, step: number} | undefined {
    if (values.length !== 2 && values.length !== 3) {
        return undefined;
    }
    const numbers = values.map(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined);
    if (numbers.some(value => value === undefined)) {
        return undefined;
    }
    const [start, end, step = 1] = numbers as number[];
    return step > 0 ? {start, end, step} : undefined;
}

/// 求值依赖检查所需的无副作用表达式子集。
function evaluateFlowExpression(tokens: RDSLToken[], environment: Map<string, FlowBinding>): FlowBinding {
    const parser = new FlowExpressionParser(tokens, environment);
    const value = parser.parse();
    return parser.complete ? value : UNKNOWN_VALUE;
}

/// 为 Requirement 检查求值整数、字符串、数组、内建函数和基础运算。
class FlowExpressionParser {
    private index = 0;

    constructor(
        private readonly tokens: RDSLToken[],
        private readonly environment: Map<string, FlowBinding>,
    ) {}

    get complete(): boolean {
        return this.index === this.tokens.length;
    }

    parse(): FlowBinding {
        return this.parseBinary(1);
    }

    private parseBinary(minimumPrecedence: number): FlowBinding {
        let lhs = this.parseUnary();
        while (this.index < this.tokens.length) {
            const operator = this.tokens[this.index].text;
            const precedence = flowOperatorPrecedence(operator);
            if (precedence < minimumPrecedence) {
                break;
            }
            this.index++;
            const rhs = this.parseBinary(precedence + 1);
            lhs = evaluateFlowBinary(lhs, operator, rhs);
        }
        return lhs;
    }

    private parseUnary(): FlowBinding {
        const operator = this.tokens[this.index]?.text;
        if (operator === '!' || operator === '-') {
            this.index++;
            const value = this.parseUnary();
            if (operator === '!' && typeof value === 'boolean') {
                return !value;
            }
            if (operator === '-' && typeof value === 'number') {
                return -value;
            }
            return UNKNOWN_VALUE;
        }
        return this.parsePrimary();
    }

    private parsePrimary(): FlowBinding {
        const token = this.tokens[this.index++];
        if (!token) {
            return UNKNOWN_VALUE;
        }
        if (token.kind === 'number') {
            const value = Number(token.text);
            return Number.isFinite(value) ? value : UNKNOWN_VALUE;
        }
        if (token.kind === 'string') {
            return interpolateFlowString(decodeString(token.text), this.environment);
        }
        if (token.text === 'true' || token.text === 'false') {
            return token.text === 'true';
        }
        if (token.text === '(') {
            const value = this.parseBinary(1);
            if (this.tokens[this.index]?.text === ')') {
                this.index++;
                return value;
            }
            return UNKNOWN_VALUE;
        }
        if (token.text === '[') {
            return this.parseArray();
        }
        if (token.kind === 'identifier') {
            if (this.tokens[this.index]?.text === '(') {
                return this.parseBuiltin(token.text);
            }
            return this.environment.get(token.text) ?? UNKNOWN_VALUE;
        }
        return UNKNOWN_VALUE;
    }

    private parseArray(): FlowBinding {
        const values: FlowBinding[] = [];
        if (this.tokens[this.index]?.text === ']') {
            this.index++;
            return [] as string[];
        }
        while (this.index < this.tokens.length) {
            values.push(this.parseBinary(1));
            if (this.tokens[this.index]?.text === ']') {
                this.index++;
                break;
            }
            if (this.tokens[this.index]?.text !== ',') {
                return UNKNOWN_VALUE;
            }
            this.index++;
        }
        if (values.every(value => typeof value === 'string')) {
            return values as string[];
        }
        if (values.every(value => typeof value === 'number')) {
            return values as number[];
        }
        return UNKNOWN_VALUE;
    }

    private parseBuiltin(name: string): FlowBinding {
        this.index++;
        const args: FlowBinding[] = [];
        if (this.tokens[this.index]?.text !== ')') {
            while (this.index < this.tokens.length) {
                args.push(this.parseBinary(1));
                if (this.tokens[this.index]?.text === ')') {
                    break;
                }
                if (this.tokens[this.index]?.text !== ',') {
                    return UNKNOWN_VALUE;
                }
                this.index++;
            }
        }
        if (this.tokens[this.index]?.text !== ')') {
            return UNKNOWN_VALUE;
        }
        this.index++;
        if (!['min', 'max', 'ceil_div'].includes(name) || args.length !== 2
            || !args.every(value => typeof value === 'number')) {
            return UNKNOWN_VALUE;
        }
        const [lhs, rhs] = args as number[];
        if (name === 'min') {
            return Math.min(lhs, rhs);
        }
        if (name === 'max') {
            return Math.max(lhs, rhs);
        }
        return rhs === 0 ? UNKNOWN_VALUE : Math.floor(lhs / rhs) + Number(lhs % rhs !== 0);
    }
}

/// 返回与 simulator 表达式解析器一致的二元运算优先级。
function flowOperatorPrecedence(operator: string): number {
    return {'||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
        '+': 5, '-': 5, '*': 6, '/': 6, '%': 6}[operator] ?? 0;
}

/// 对轻量求值器中的二元表达式执行类型安全运算。
function evaluateFlowBinary(lhs: FlowBinding, operator: string, rhs: FlowBinding): FlowBinding {
    if (lhs === UNKNOWN_VALUE || rhs === UNKNOWN_VALUE) {
        return UNKNOWN_VALUE;
    }
    if (operator === '==' || operator === '!=') {
        const equal = lhs === rhs;
        return operator === '==' ? equal : !equal;
    }
    if (operator === '&&' || operator === '||') {
        return typeof lhs === 'boolean' && typeof rhs === 'boolean'
            ? (operator === '&&' ? lhs && rhs : lhs || rhs)
            : UNKNOWN_VALUE;
    }
    if (typeof lhs !== 'number' || typeof rhs !== 'number') {
        return UNKNOWN_VALUE;
    }
    switch (operator) {
        case '+': return lhs + rhs;
        case '-': return lhs - rhs;
        case '*': return lhs * rhs;
        case '/': return rhs === 0 ? UNKNOWN_VALUE : (Number.isInteger(lhs) && Number.isInteger(rhs) ? Math.floor(lhs / rhs) : lhs / rhs);
        case '%': return rhs === 0 ? UNKNOWN_VALUE : lhs % rhs;
        case '<': return lhs < rhs;
        case '<=': return lhs <= rhs;
        case '>': return lhs > rhs;
        case '>=': return lhs >= rhs;
        default: return UNKNOWN_VALUE;
    }
}

/// 使用当前词法环境展开字符串中的 `${variable}`。
function interpolateFlowString(value: string, environment: Map<string, FlowBinding>): FlowBinding {
    let valid = true;
    const interpolated = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
        const replacement = environment.get(name);
        if (typeof replacement !== 'string' && typeof replacement !== 'number' && typeof replacement !== 'boolean') {
            valid = false;
            return '';
        }
        return String(replacement);
    });
    return valid ? interpolated : UNKNOWN_VALUE;
}

/// 收集排除关键字、指令名和具名参数名后的变量引用。
function collectReferences(tokens: RDSLToken[], calls: InstructionCall[], definitions: VariableDefinition[]): RDSLToken[] {
    const ignored = new Set<RDSLToken>();
    for (const call of calls) {
        ignored.add(call.nameToken);
        for (const arg of call.args) {
            ignored.add(arg.nameToken);
        }
    }
    for (const definition of definitions) {
        ignored.add(definition.token);
    }
    return tokens.filter(token => token.kind === 'identifier'
        && !ignored.has(token)
        && !KEYWORDS.has(token.text)
        && !BUILTINS.has(token.text));
}

/// 对裸标识符执行按源码顺序的未定义变量检查。
function validateVariableReferences(references: RDSLToken[], definitions: VariableDefinition[], issues: DiagnosticIssue[]): void {
    for (const reference of references) {
        if (!definitions.some(definition => definition.name === reference.text && definition.token.start < reference.start)) {
            issues.push({start: reference.start, end: reference.end, message: `变量 \`${reference.text}\` 尚未定义；字符串和枚举值需要加引号`, severity: 'error'});
        }
    }
}

/// 解码诊断阶段需要使用的基本字符串转义。
function decodeString(text: string): string {
    return text.slice(1, text.endsWith('"') ? -1 : undefined)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}
