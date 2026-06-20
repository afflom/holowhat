/**
 * holo-messenger.js — Messenger App Implementation
 * 
 * This file implements the worked example app 'holo-messenger' on top of the
 * holo-apps platform. It defines:
 * - App-specific kinds: 'message', 'reaction', 'edit'
 * - The deterministic reducer fold (topological sorting + tiebreak evaluation is inherited)
 * - The projection view generator
 */

import { App, canonicalJson, sha256 } from "./holo-apps.js";

/**
 * Deterministic reducer for holo-messenger.
 * 
 * Input: Topological sorted and decrypted array of event objects:
 *   { id, author, clock, kind, payload }
 * 
 * Output: Projection state containing list of processed messages:
 *   { messages: Array, threads: Map }
 */
export function messengerReducer(events) {
  const messageMap = new Map(); // messageId -> Message object

  for (const ev of events) {
    const payload = ev.payload || {};
    const type = payload.type || "";
    
    if (ev.kind === "message" || type === "Create") {
      const body = payload.object?.content || payload.body;
      const timestamp = payload.object?.published 
        ? new Date(payload.object.published).getTime() 
        : (payload.timestamp || Date.now());
      const parentId = payload.object?.inReplyTo || payload.parentId || null;
      const attachment = payload.object?.attachment || payload.attachment || null;
      
      messageMap.set(ev.id, {
        id: ev.id,
        author: ev.author,
        clock: ev.clock,
        body: body,
        parentId: parentId,
        timestamp: timestamp,
        attachment: attachment,
        reactions: new Map(), // symbol -> Set of authors
        edits: [], // Edit history [{ id, author, clock, body }]
        replies: [] // Reply message IDs
      });
    } else if (ev.kind === "edit" || type === "Update") {
      const targetId = payload.object?.id || payload.target;
      const body = payload.object?.content || payload.body;
      if (messageMap.has(targetId)) {
        const msg = messageMap.get(targetId);
        // Only the original author can edit their message
        if (msg.author === ev.author) {
          msg.edits.push({
            id: ev.id,
            author: ev.author,
            clock: ev.clock,
            body: body
          });
          // Update the current visible body text to the latest edit
          msg.body = body;
        }
      }
    } else if (ev.kind === "reaction" || type === "Like") {
      const targetId = payload.object || payload.target;
      const symbol = payload.content || payload.symbol;
      if (messageMap.has(targetId)) {
        const msg = messageMap.get(targetId);
        if (!msg.reactions.has(symbol)) {
          msg.reactions.set(symbol, new Set());
        }
        msg.reactions.get(symbol).add(ev.author);
      }
    } else if (ev.kind === "delete" || type === "Delete") {
      const targetId = payload.object?.id || payload.target || (typeof payload.object === "string" ? payload.object : null);
      if (targetId && messageMap.has(targetId)) {
        const msg = messageMap.get(targetId);
        // Only the original author can retract their message
        if (msg.author === ev.author) {
          messageMap.delete(targetId);
        }
      }
    }
  }

  // Build thread hierarchies (replies)
  const rootMessages = [];
  for (const msg of messageMap.values()) {
    if (msg.parentId && messageMap.has(msg.parentId)) {
      messageMap.get(msg.parentId).replies.push(msg.id);
    } else {
      rootMessages.push(msg);
    }
  }

  // Convert reaction sets to standard array format for JSON projection compatibility
  const formatReactions = (reactionsMap) => {
    const list = [];
    for (const [symbol, authors] of reactionsMap.entries()) {
      list.push({ symbol, count: authors.size, authors: Array.from(authors) });
    }
    return list;
  };

  const messagesList = Array.from(messageMap.values()).map(msg => ({
    ...msg,
    reactions: formatReactions(msg.reactions)
  }));

  return {
    messages: messagesList.sort((a, b) => {
      if (a.clock !== b.clock) return a.clock - b.clock;
      return a.id.localeCompare(b.id);
    }),
    rootMessages: rootMessages.map(msg => msg.id)
  };
}

/**
 * Creates the official holo-messenger App Manifest.
 */
export async function createMessengerApp(participant) {
  // Pinned reducer & UI projection hashes (code-as-κ mock targets representing the specifications)
  const reducerId = await sha256(messengerReducer.toString());
  const projectionId = await sha256("holo-messenger-ui-bundle-v1");
  
  return await App.create(
    "holo-messenger",
    reducerId,
    projectionId,
    ["message", "reaction", "edit", "delete"],
    ["read", "write"],
    participant
  );
}
