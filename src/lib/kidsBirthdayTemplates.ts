export type InvitationTemplateId =
  | 'kids_jungle'
  | 'kids_unicorn'
  | 'kids_space';

export type InvitationTemplateCategory =
  | 'kids_birthday';

export type InvitationTemplate = {
  id: InvitationTemplateId;
  name: string;
  category: InvitationTemplateCategory;
  thumbnail: string;
  background: string;
};

export const kidsBirthdayTemplates: InvitationTemplate[] = [
  {
    id: 'kids_jungle',
    name: 'Selva divertida',
    category: 'kids_birthday',
    thumbnail: '/invitation-templates/kids-birthday/jungle.png',
    background: '/invitation-templates/kids-birthday/jungle.png',
  },
  {
    id: 'kids_unicorn',
    name: 'Unicornio mágico',
    category: 'kids_birthday',
    thumbnail: '/invitation-templates/kids-birthday/unicorn.png',
    background: '/invitation-templates/kids-birthday/unicorn.png',
  },
  {
    id: 'kids_space',
    name: 'Aventura espacial',
    category: 'kids_birthday',
    thumbnail: '/invitation-templates/kids-birthday/space.png',
    background: '/invitation-templates/kids-birthday/space.png',
  },
];
