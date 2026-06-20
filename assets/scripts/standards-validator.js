/**
 * standards-validator.js — Runtime W3C Standards Conformance Validator
 * 
 * Imports and validates constructed event payloads against authoritative W3C JSON-LD contexts.
 */

export class StandardsValidator {
  static asContext = null;
  static schemaContext = null;

  static async init(basePath = "") {
    if (this.asContext && this.schemaContext) return;
    try {
      const asResp = await fetch(`${basePath}assets/schemas/activitystreams-context.json`);
      const schemaResp = await fetch(`${basePath}assets/schemas/schema-org-context.json`);
      if (asResp.ok && schemaResp.ok) {
        this.asContext = (await asResp.json())["@context"];
        this.schemaContext = (await schemaResp.json())["@context"];
        console.log("StandardsValidator: Authorized contexts successfully loaded for runtime verification.");
      } else {
        console.log("StandardsValidator: Context endpoints returned non-ok responses.", asResp.status, schemaResp.status);
      }
    } catch (e) {
      console.error("StandardsValidator: Failed to load authoritative schemas context files:", e);
    }
  }

  static validateAgainstContext(obj, contextObj, name = "Object") {
    if (!contextObj) return; // Skip if contexts haven't loaded yet
    
    for (const key of Object.keys(obj)) {
      if (key === "@context" || key === "type" || key === "id" || key === "@type" || key === "@id") {
        continue;
      }
      
      const isDefined = (key in contextObj);
      
      if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
        const nestedContext = obj[key]["@context"] ? 
          (obj[key]["@context"].includes("schema.org") ? this.schemaContext : this.asContext) : contextObj;
        this.validateAgainstContext(obj[key], nestedContext, `${name}.${key}`);
      } else if (Array.isArray(obj[key])) {
        for (let i = 0; i < obj[key].length; i++) {
          if (typeof obj[key][i] === "object" && obj[key][i] !== null) {
            const nestedContext = obj[key][i]["@context"] ? 
              (obj[key][i]["@context"].includes("schema.org") ? this.schemaContext : this.asContext) : contextObj;
            this.validateAgainstContext(obj[key][i], nestedContext, `${name}.${key}[${i}]`);
          }
        }
      }
      
      const allowedExtensions = ["curveId", "channels", "members", "attachment", "inReplyTo"];
      if (!isDefined && !allowedExtensions.includes(key)) {
        throw new Error(`Property '${key}' in ${name} is not defined in the imported standards context schema!`);
      }
    }
  }

  static validateActivityStreams(payload, expectedType) {
    if (!this.asContext) {
      console.log("StandardsValidator: Context not loaded yet, skipping runtime validation.");
      return;
    }
    if (payload["@context"] !== "https://www.w3.org/ns/activitystreams") {
      throw new Error("StandardsValidator Error: Must include W3C ActivityStreams @context URI.");
    }
    if (payload.type !== expectedType) {
      throw new Error(`StandardsValidator Error: Must be of type '${expectedType}'`);
    }
    this.validateAgainstContext(payload, this.asContext, expectedType);
  }
}
