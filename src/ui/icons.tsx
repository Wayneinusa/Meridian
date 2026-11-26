import type { ReactNode } from "react";

const S = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icon = {
  menu: () => <S><path d="M4 7h16M4 12h16M4 17h16" /></S>,
  plus: () => <S><path d="M12 5v14M5 12h14" /></S>,
  skill: () => <S><path d="M12 3l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 8.3l5-.7z" /><path d="M8 21h8" /></S>,
  team: () => <S><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.4" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M14.5 14.6c.8-.4 1.6-.6 2.5-.6 2.2 0 3.8 1.4 4.3 4" /></S>,
  info: () => <S><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.01" /></S>,
  alert: () => <S><path d="M12 3l9.5 16.5h-19z" /><path d="M12 10v4M12 17.5v.01" /></S>,
  chat: () => <S><path d="M4 5h16v11H9l-5 4z" /></S>,
  bank: () => <S><path d="M3 9l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" /></S>,
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
  agent: () => <S><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></S>,
  folder: () => <S><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></S>,
  prompt: () => <S><path d="M4 5h16v11H8l-4 4z" /><path d="M8 9h8M8 12h5" /></S>,
  clock: () => <S><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></S>,
  chart: () => <S><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></S>,
  mask: () => <S><path d="M3 9c3-2 15-2 18 0 0 5-3 8-5 8-1.5 0-2.5-2-4-2s-2.5 2-4 2c-2 0-5-3-5-8z" /><circle cx="8.5" cy="11" r="1.3" /><circle cx="15.5" cy="11" r="1.3" /></S>,
  mic: () => <S><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></S>,
  speaker: () => <S><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></S>,
  fork: () => <S><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5" /></S>,
  archive: () => <S><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11h14V8M10 12h4" /></S>,
  more: () => <S><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></S>,
  globe: () => <S><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></S>,
  compare: () => <S><rect x="3" y="4" width="8" height="16" rx="1.5" /><rect x="13" y="4" width="8" height="16" rx="1.5" /></S>,
  file: () => <S><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></S>,
  puzzle: () => <S><path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z" /></S>,
  star: () => <S><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></S>,
  bolt: () => <S><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></S>,
};
