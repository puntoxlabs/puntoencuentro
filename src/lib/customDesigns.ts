export const CUSTOM_DESIGNS_CONFIG = {
  ENABLED: true,
  LIMIT: 3,
  PREMIUM_REQUIRED: false,
  MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
  ACCEPTED_FORMATS: ['image/jpeg', 'image/png', 'image/webp'],
  BUCKET: 'custom-invitation-templates',
};

export interface CustomInvitationTemplate {
  id: string;
  name: string;
  image_path: string;
  thumbnail_path: string | null;
  image_url: string | null;
  thumbnail_url: string | null;
  overlay_opacity: number;
  created_at: string;
}
