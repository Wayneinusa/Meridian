import type { ReactNode } from "react";

const S = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icon = {
  menu: () => <S><path d="M4 7h16M4 12h16M4 17h16" /></S>,
  plus: () => <S><path d="M12 5v14M5 12h14" /></S>,
  send: () => <S><path d="M12 19V5M5 12l7-7 7 7" /></S>,
  stop: () => <S><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></S>,
  gear: () => <S><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></S>,
  sliders: () => <S><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></S>,
  clip: () => <S><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7" /></S>,
  tools: () => <S><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></S>,
  trash: () => <S><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></S>,
  pin: () => <S><path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" /></S>,
  edit: () => <S><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></S>,
  copy: () => <S><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></S>,
  check: () => <S><path d="M5 12.5l4.5 4.5L19 7.5" /></S>,
  x: () => <S><path d="M6 6l12 12M18 6L6 18" /></S>,
  refresh: () => <S><path d="M20 11a8 8 0 0 0-14.3-4.3L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.3L20 16M20 20v-4h-4" /></S>,
  chevron: () => <S><path d="M6 9l6 6 6-6" /></S>,
  download: () => <S><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></S>,
  eye: () => <S><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></S>,
  open: () => <S><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></S>,
  cloud: () => <S><path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 10.2a4 4 0 0 1-.5 7.8z" /></S>,
  search: () => <S><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></S>,
};
