import { BridgeRequestConfig } from './types';

/**
 * Serializes params into a query string.
 */
export function serializeParams(params: Record<string, unknown> | URLSearchParams | undefined): string {
  if (!params) return '';

  if (params instanceof URLSearchParams) {
    return params.toString();
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}

/**
 * Builds the full URL from config (baseURL + url + params).
 */
export function buildFullURL(config: BridgeRequestConfig): string {
  let fullURL = config.url || '';

  if (config.baseURL && !isAbsoluteURL(fullURL)) {
    fullURL = combineURLs(config.baseURL, fullURL);
  }

  const queryString = serializeParams(config.params as Record<string, unknown> | URLSearchParams | undefined);
  if (queryString) {
    const separator = fullURL.includes('?') ? '&' : '?';
    fullURL = fullURL + separator + queryString;
  }

  return fullURL;
}

function isAbsoluteURL(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function combineURLs(baseURL: string, relativeURL: string): string {
  return relativeURL
    ? baseURL.replace(/\/+$/, '') + '/' + relativeURL.replace(/^\/+/, '')
    : baseURL;
}

/**
 * Deep merges configuration objects. Later sources win.
 */
export function mergeConfig(
  ...sources: Array<BridgeRequestConfig | undefined>
): BridgeRequestConfig {
  const result: BridgeRequestConfig = {};

  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (key === 'headers' && typeof value === 'object' && value !== null) {
        (result as Record<string, unknown>)[key] = {
          ...((result as Record<string, unknown>)[key] as Record<string, unknown> || {}),
          ...(value as Record<string, unknown>),
        };
      } else {
        (result as Record<string, unknown>)[key] = value;
      }
    }
  }

  return result;
}
