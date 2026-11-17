/* Line icons, same 24x24 box and round caps everywhere. */
import type { ReactNode } from "react";

type P = { className?: string; width?: number; title?: string };

const line = (children: ReactNode, sw = 1.8) =>
  function Icon({ className }: P) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    );
  };

export const IconClose = line(<path d="M6 6l12 12M18 6 6 18" />, 2);
export const IconPlus = line(<path d="M12 5.2v13.6M5.2 12h13.6" />);
export const IconHeart = line(<path d="M12 20.5 4.6 13a4.7 4.7 0 0 1 6.6-6.7l.8.8.8-.8A4.7 4.7 0 0 1 19.4 13z" />);
export const IconHeartBar = line(<path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z" />, 1.7);
export const IconHelp = line(<><path d="M9.1 9.2a3 3 0 0 1 5.8 1c0 1.9-2.9 2.4-2.9 4" /><path d="M12 17.6h.01" /></>, 1.7);
export const IconGear = line(<><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.9 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.4a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9.4a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>, 1.8);
export const IconDownloads = line(<><path d="M12 4.2v10.2" /><path d="m7.9 10.3 4.1 4.1 4.1-4.1" /><path d="M5 17.6V19a1.6 1.6 0 0 0 1.6 1.6h10.8A1.6 1.6 0 0 0 19 19v-1.4" /></>, 1.6);
export const IconTray = line(<><path d="M12 4v10" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><path d="M5 19h14" /></>);
export const IconRemux = line(<><path d="M4 9h11" /><path d="m7 6-3 3 3 3" /><path d="M20 15H9" /><path d="m17 12 3 3-3 3" /></>, 1.7);
export const IconSubs = line(<><path d="M4 5.5h16v11H9l-4 3.5v-3.5H4z" /><path d="M8 10h8M8 13.5h5" /></>, 1.6);
export const IconSliders = line(<><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2.2" /><circle cx="9" cy="17" r="2.2" /></>, 1.6);
export const IconMoon = line(<path d="M20.2 15.1A8.9 8.9 0 1 1 9.4 4.3a7 7 0 0 0 10.8 10.8Z" />, 1.7);
export const IconNote = line(<><path d="M9 18V6.5l9-2V16" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="15.5" cy="16" r="2.5" /></>);
export const IconLink = line(<><path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7L11.4 6.4" /><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3" /></>);
export const IconPaste = line(<><rect x="8" y="4" width="12" height="16" rx="2.5" /><path d="M16 4V3.2A1.2 1.2 0 0 0 14.8 2H9.2A1.2 1.2 0 0 0 8 3.2V4" /><path d="M4 8v11.5A1.5 1.5 0 0 0 5.5 21H13" /></>);
export const IconGet = line(<><path d="M12 4v10" /><path d="m7.8 10.2 4.2 4.2 4.2-4.2" /><path d="M5 19h14" /></>, 1.9);
export const IconCheck = line(<path d="m5 12.5 4.5 4.5L19 7" />, 2.2);
export const IconBack = line(<><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>, 1.9);
export const IconArrow = line(<><path d="M5 12h13" /><path d="m12.5 6 6 6-6 6" /></>, 2);
export const IconRetry = line(<><path d="M20 11a8 8 0 1 0-2.6 6" /><path d="M20 5v6h-6" /></>, 1.9);
export const IconFlag = line(<><path d="M5 21V4" /><path d="M5 5h10l-1.2 3L15 11H5" /></>, 1.9);
export const IconSave = line(<><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 19.5h14" /></>, 1.9);
export const IconShare = line(<><path d="M12 15V4" /><path d="m8 8 4-4 4 4" /><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></>, 1.9);
export const IconOpen = line(<><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>, 1.9);
export const IconDots = line(<><circle cx="12" cy="6" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="18" r="1.4" /></>, 1.9);
export const IconCopy = line(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>, 1.9);
export const IconCard = line(<><rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2.6" /><path d="M2.6 10h18.8" /><path d="M6.4 15h3.2" /></>, 1.7);
export const IconFile = line(<><path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M13.5 3v5.5H19" /></>, 1.6);
export const IconVideo = line(<><rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M10 9.5v5l4.5-2.5z" fill="currentColor" stroke="none" /></>);

export function BrandMark({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g className="mark-arrow"><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /></g>
      <path className="mark-tray" d="M4 19h16" />
    </svg>
  );
}

/** a trusted, static SVG string from this codebase (service marks, coins) */
export function Svg({ html, className }: { html: string; className?: string }) {
  return <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
}

/* settings section icons */
export const NavIcons: Record<string, ReturnType<typeof line>> = {
  appearance: line(<><circle cx="12" cy="12" r="4" /><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" /></>),
  video: line(<><rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="m10.2 9.2 4.9 2.8-4.9 2.8z" /></>),
  audio: line(<><path d="M9 17.4V5.6l10-2v11.8" /><circle cx="6.3" cy="17.9" r="2.8" /><circle cx="16.3" cy="15.9" r="2.8" /></>),
  output: line(<><path d="M14 3.2H7.4a2.2 2.2 0 0 0-2.2 2.2v13.2a2.2 2.2 0 0 0 2.2 2.2h9.2a2.2 2.2 0 0 0 2.2-2.2V8z" /><path d="M14 3.2V8h4.8" /></>),
  privacy: line(<><rect x="4.4" y="10.2" width="15.2" height="10.4" rx="2.6" /><path d="M8.2 10.2V7.4a3.8 3.8 0 0 1 7.6 0v2.8" /></>),
  advanced: line(<><path d="M4 7.4h9.2M19 7.4h1M4 16.6h3.4M11.4 16.6H20" /><circle cx="16" cy="7.4" r="2.2" /><circle cx="9.4" cy="16.6" r="2.2" /></>),
  instance: line(<><circle cx="12" cy="12" r="8.8" /><path d="M3.4 12h17.2" /><path d="M12 3.2a14 14 0 0 1 0 17.6a14 14 0 0 1 0-17.6z" /></>),
};
