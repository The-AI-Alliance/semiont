/**
 * Translation management interface
 * Apps implement this to provide translations using their preferred i18n library
 */
export interface TranslationManager {
  /**
   * Translate a key within a namespace
   * @param namespace - Translation namespace (e.g., 'Toolbar', 'ResourceViewer')
   * @param key - Translation key within the namespace
   * @returns Translated string
   */
  t: (namespace: string, key: string) => string;
}
