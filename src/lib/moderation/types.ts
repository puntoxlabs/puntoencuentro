export type ModerationDecision = 'allow' | 'review' | 'block';

export type ModerationReasonCode =
  | 'clean_social_meetup'
  | 'unsupported_language'
  | 'gibberish'
  | 'excessive_symbols'
  | 'external_contact'
  | 'obfuscated_contact'
  | 'commercial_spam'
  | 'duplicate_content'
  | 'duplicate_content_burst'
  | 'suspicious_url'
  | 'possible_scam'
  | 'low_information_content'
  | 'malicious_payload'
  | 'violence_threat'
  | 'illegal_activity'
  | 'contains_link'
  | 'contains_personal_contact_data'
  | 'sensitive_terms_ambiguous'
  | 'title_too_short'
  | 'moderation_unavailable';

export interface ModerationEvaluationResult {
  decision: ModerationDecision;
  categories: string[];
  confidence: number;
  reason_code: ModerationReasonCode;
  explanation_for_moderator?: string;
  user_friendly_message?: string;
}

export interface PublicEncounterCandidate {
  id?: string;
  title: string;
  description?: string | null;
  fecha?: string | null;
  hora?: string | null;
  modality?: string;
  approximate_zone?: string;
  zona?: string | null;
  open_public_zone?: string | null;
  locality_id?: string | null;
  host_id?: string;
  created_at?: string | null;
}

export interface RecentEncounterHistory {
  id: string;
  title?: string;
  open_public_title?: string;
  description?: string | null;
  open_description?: string | null;
  fecha?: string | null;
  hora?: string | null;
  zona?: string | null;
  open_public_zone?: string | null;
  locality_id?: string | null;
  created_at?: string | null;
}

export interface PrivateContentGateResult {
  allowed: boolean;
  reason?: 'malicious_payload' | 'phishing' | 'credential_theft' | 'severe_scam' | 'clean';
  user_friendly_message?: string;
}
