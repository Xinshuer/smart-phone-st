// Character anchor — when a contact has been "locked", reuse the same
// (anchor prompt, seed) for every subsequent image of that character so
// hair/eyes/face stay consistent across messages.

// Resolves the relevant contact for a given <pic> generation context.
// Strategy:
//   1. If the contact is explicitly named in the surrounding YAML payload (from field), use that.
//   2. Otherwise, scan the AI prompt for any contact name as substring.
//   3. Fallback: null (no anchor, generate fresh).

export function resolveContact(picTag, contacts, hint = {}) {
    // hint.from is preferred (passed from phone protocol context)
    if (hint.from) {
        const c = contacts.find((c) => c.name === hint.from);
        if (c) return c;
    }
    // Fallback: scan tag content for known names
    for (const c of contacts) {
        if (c.name && (picTag.includes(c.name) || (hint.context || '').includes(c.name))) {
            return c;
        }
    }
    return null;
}

export function getAnchorBundle(contact) {
    if (!contact?.anchor) return { prompt: '', sdPrompt: '', seed: null, locked: false };
    return {
        prompt: contact.anchor.prompt || '',
        sdPrompt: contact.anchor.sdPrompt || '',
        seed: contact.anchor.locked ? contact.anchor.seed : null,
        locked: !!contact.anchor.locked,
    };
}
