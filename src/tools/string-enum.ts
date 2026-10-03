import { Type, type TUnsafe } from "typebox";

/**
 * A string-literal union schema (`{ type: "string", enum: [...] }`).
 * pi-ai stopped exporting StringEnum in 1.0, and hosts that pin a newer pi-ai
 * (PI-Desktop) would otherwise fail to load the tools, so it lives here.
 */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string; default?: T[number] } = {},
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
