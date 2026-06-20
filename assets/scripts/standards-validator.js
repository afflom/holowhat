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

  static validateAgainstContext(obj, contextObj, name = "Object", dynamicContexts = []) {
    if (!contextObj) return; // Skip if contexts haven't loaded yet
    
    // Build a unified resolved context from the static context object and any dynamic context structures passed
    const resolvedContext = { ...contextObj };
    for (const dc of dynamicContexts) {
      if (typeof dc === "object" && dc !== null) {
        Object.assign(resolvedContext, dc);
      }
    }
    
    for (const key of Object.keys(obj)) {
      if (key === "@context" || key === "type" || key === "id" || key === "@type" || key === "@id") {
        continue;
      }
      
      const isDefined = (key in resolvedContext);
      
      // Perform simple validation constraints on standard fields if they are present
      if (key === "published" && typeof obj[key] === "string") {
        const isIsoDate = !isNaN(Date.parse(obj[key]));
        if (!isIsoDate) {
          throw new Error(`Property 'published' in ${name} must be a valid ISO 8601 datetime string.`);
        }
      }
      
      const allowedExtensions = ["curveId", "channels", "members", "attachment", "inReplyTo", "capabilities"];
      if (!isDefined && !allowedExtensions.includes(key)) {
        throw new Error(`Property '${key}' in ${name} is not defined in the imported standards context schema!`);
      }

      if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
        const nestedContexts = obj[key]["@context"] ? 
          (Array.isArray(obj[key]["@context"]) ? obj[key]["@context"] : [obj[key]["@context"]]) : [];
        const localDyn = nestedContexts.filter(c => typeof c === "object");
        const baseCtx = (obj[key]["@context"] && JSON.stringify(obj[key]["@context"]).includes("schema.org")) ? this.schemaContext : contextObj;
        this.validateAgainstContext(obj[key], baseCtx, `${name}.${key}`, localDyn);
      } else if (Array.isArray(obj[key])) {
        for (let i = 0; i < obj[key].length; i++) {
          if (typeof obj[key][i] === "object" && obj[key][i] !== null) {
            const nestedContexts = obj[key][i]["@context"] ? 
              (Array.isArray(obj[key][i]["@context"]) ? obj[key][i]["@context"] : [obj[key][i]["@context"]]) : [];
            const localDyn = nestedContexts.filter(c => typeof c === "object");
            const baseCtx = (obj[key][i]["@context"] && JSON.stringify(obj[key][i]["@context"]).includes("schema.org")) ? this.schemaContext : contextObj;
            this.validateAgainstContext(obj[key][i], baseCtx, `${name}.${key}[${i}]`, localDyn);
          }
        }
      }
    }
  }

  static validateActivityStreams(payload, expectedType) {
    if (!this.asContext) {
      console.log("StandardsValidator: Context not loaded yet, skipping runtime validation.");
      return;
    }
    
    const contexts = Array.isArray(payload["@context"]) ? payload["@context"] : [payload["@context"]];
    const hasASUri = contexts.includes("https://www.w3.org/ns/activitystreams");
    
    if (!hasASUri) {
      throw new Error("StandardsValidator Error: Must include W3C ActivityStreams @context URI.");
    }
    if (payload.type !== expectedType) {
      throw new Error(`StandardsValidator Error: Must be of type '${expectedType}'`);
    }

    // Extract dynamic contexts
    const dynamicContexts = contexts.filter(c => typeof c === "object");
    this.validateAgainstContext(payload, this.asContext, expectedType, dynamicContexts);
  }
}
