/**
 * External platform resources - for externally managed services
 */
export interface ExternalResources {
  endpoint?: string;
  host?: string;
  port?: number;
  protocol?: string;
  path?: string;
  documentation?: string;
  provider?: string;
  apiKey?: string;  // Reference to where key is stored, not the key itself
}