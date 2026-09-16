declare const brandSymbol: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brandSymbol]: Name };
