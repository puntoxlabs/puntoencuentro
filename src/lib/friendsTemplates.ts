export type FriendsTemplateId =
  | 'friends_coffee'
  | 'friends_night'
  | 'friends_picnic';

export interface FriendsTemplateConfig {
  id: FriendsTemplateId;
  name: string;
  category: 'friends';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const friendsTemplates: FriendsTemplateConfig[] = [
  {
    id: 'friends_coffee',
    name: 'Café',
    category: 'friends',
    previewColor: 'linear-gradient(135deg, #d4a373 0%, #faedcb 50%, #ccd5ae 100%)',
    thumbnail: '/invitation-templates/friends/friends_coffee_v3.webp?v=3',
    background: '/invitation-templates/friends/friends_coffee_v3.webp?v=3'
  },
  {
    id: 'friends_night',
    name: 'Noche',
    category: 'friends',
    previewColor: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4c1d95 100%)',
    thumbnail: '/invitation-templates/friends/friends_night_v3.webp?v=3',
    background: '/invitation-templates/friends/friends_night_v4.webp?v=4'
  },
  {
    id: 'friends_picnic',
    name: 'Juntada',
    category: 'friends',
    previewColor: 'linear-gradient(135deg, #a3b18a 0%, #dad7cd 50%, #fefae0 100%)',
    thumbnail: '/invitation-templates/friends/friends_picnic_v3.webp?v=3',
    background: '/invitation-templates/friends/friends_picnic_v4.webp?v=4'
  }
];

export function getFriendsTemplateConfig(templateId?: string | null): FriendsTemplateConfig | null {
  if (!templateId) return null;
  const found = friendsTemplates.find(t => t.id === templateId);
  return found || null;
}
