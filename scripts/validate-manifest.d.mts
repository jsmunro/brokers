export declare class ManifestValidationError extends Error {
  errors: string[];
  constructor(errors: string[]);
}

/** Validates a parsed manifest object. Returns an array of error strings (empty = valid). */
export declare function validateManifest(manifest: unknown): string[];

/** Parses and validates the manifest JSON text. Throws `ManifestValidationError` on any failure. */
export declare function parseAndValidateManifest(text: string): any;
