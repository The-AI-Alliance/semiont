import { deleteCookie } from './cleanup';

// Get user's location for CCPA vs GDPR detection (simplified)
export const getUserLocation = async (): Promise<'EU' | 'CA' | 'US' | 'OTHER'> => {
  try {
    // In a real implementation, you'd use a geolocation service
    // For now, we'll detect based on timezone as a rough approximation
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (timezone.includes('Europe/')) return 'EU';
    if (timezone.includes('America/Los_Angeles') || timezone.includes('America/Vancouver')) return 'CA';
    if (timezone.includes('America/')) return 'US';

    return 'OTHER';
  } catch {
    return 'OTHER';
  }
};

// Check if CCPA applies (California residents)
export const isCCPAApplicable = async (): Promise<boolean> => {
  const location = await getUserLocation();
  return location === 'CA';
};

// Check if GDPR applies (EU residents)
export const isGDPRApplicable = async (): Promise<boolean> => {
  const location = await getUserLocation();
  return location === 'EU';
};

// Export all cookies currently set
export const exportUserData = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};

  const data: Record<string, string> = {};

  // Get all cookies
  document.cookie.split(';').forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (name && value) {
      data[`cookie_${name}`] = decodeURIComponent(value);
    }
  });

  // Get localStorage data
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      data[`localStorage_${key}`] = localStorage.getItem(key) || '';
    }
  }

  // Get sessionStorage data
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key) {
      data[`sessionStorage_${key}`] = sessionStorage.getItem(key) || '';
    }
  }

  return data;
};

// Delete all user data (GDPR right to be forgotten)
export const deleteAllUserData = (): void => {
  if (typeof window === 'undefined') return;

  // Clear all localStorage
  localStorage.clear();

  // Clear all sessionStorage
  sessionStorage.clear();

  // Delete all cookies
  document.cookie.split(';').forEach(cookie => {
    const name = cookie.split('=')[0]?.trim();
    if (name) {
      deleteCookie(name);
    }
  });

  // Reload page to ensure clean state
  window.location.reload();
};
