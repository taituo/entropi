export type ErrorCode = "not_found" | "forbidden" | "conflict" | "invalid";

/** Domain failures carry a stable code so transports can map them without parsing messages. */
export class CoreError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "CoreError";
		this.code = code;
	}
}
export const notFound = (what: string) => new CoreError("not_found", `${what} not found`);
export const forbidden = (why: string) => new CoreError("forbidden", why);
export const conflict = (why: string) => new CoreError("conflict", why);
export const invalid = (why: string) => new CoreError("invalid", why);
