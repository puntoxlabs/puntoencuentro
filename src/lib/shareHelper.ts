export function isMobileShareEnvironment(): boolean {
  // Same regex logic as before to detect mobile environment
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}
