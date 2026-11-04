/**
 * Replaces {placeholders} with values. Unknown placeholders are left as-is so
 * typos are visible in Discord instead of silently rendering "undefined".
 */
export function renderTemplate(template, values) {
  if (!template) return '';

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null ? match : String(value);
  });
}
