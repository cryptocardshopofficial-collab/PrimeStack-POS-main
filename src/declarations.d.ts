// Type declarations for modules without bundled type definitions

declare module 'fastify-plugin' {
  import type { FastifyPluginCallback, FastifyPluginAsync, FastifyPluginOptions } from 'fastify';
  function fp<Options extends FastifyPluginOptions = Record<never, never>>(
    fn: FastifyPluginCallback<Options> | FastifyPluginAsync<Options>,
    options?: {
      fastify?: string;
      name?: string;
      decorators?: object;
      dependencies?: string[];
      encapsulate?: boolean;
    }
  ): typeof fn;
  export default fp;
}

declare module 'decimal.js' {
  type Value = string | number | Decimal;
  class Decimal {
    constructor(value: Value);
    // Static config
    static set(config: { precision?: number; rounding?: number; [k: string]: unknown }): void;
    static readonly ROUND_UP: number;
    static readonly ROUND_DOWN: number;
    static readonly ROUND_CEIL: number;
    static readonly ROUND_FLOOR: number;
    static readonly ROUND_HALF_UP: number;
    static readonly ROUND_HALF_DOWN: number;
    static readonly ROUND_HALF_EVEN: number;
    static readonly ROUND_HALF_CEIL: number;
    static readonly ROUND_HALF_FLOOR: number;
    // Static math
    static min(...values: Value[]): Decimal;
    static max(...values: Value[]): Decimal;
    static sum(...values: Value[]): Decimal;
    // Arithmetic
    plus(n: Value): Decimal;
    minus(n: Value): Decimal;
    times(n: Value): Decimal;
    dividedBy(n: Value): Decimal;
    mod(n: Value): Decimal;
    pow(n: Value): Decimal;
    abs(): Decimal;
    negated(): Decimal;
    sqrt(): Decimal;
    // Aliases
    add(n: Value): Decimal;
    sub(n: Value): Decimal;
    mul(n: Value): Decimal;
    div(n: Value): Decimal;
    // Rounding / formatting
    toDecimalPlaces(dp: number, rm?: number): Decimal;
    toFixed(dp?: number, rm?: number): string;
    toPrecision(sd?: number, rm?: number): string;
    toSignificantDigits(sd?: number, rm?: number): Decimal;
    toString(): string;
    toNumber(): number;
    toJSON(): string;
    valueOf(): string;
    // Inspection
    decimalPlaces(): number;
    isNaN(): boolean;
    isFinite(): boolean;
    isZero(): boolean;
    isInteger(): boolean;
    isPositive(): boolean;
    isNegative(): boolean;
    // Comparison
    equals(n: Value): boolean;
    eq(n: Value): boolean;
    greaterThan(n: Value): boolean;
    gt(n: Value): boolean;
    greaterThanOrEqualTo(n: Value): boolean;
    gte(n: Value): boolean;
    lessThan(n: Value): boolean;
    lt(n: Value): boolean;
    lessThanOrEqualTo(n: Value): boolean;
    lte(n: Value): boolean;
    comparedTo(n: Value): number;
    cmp(n: Value): number;
  }
  export default Decimal;
  export { Decimal };
}
