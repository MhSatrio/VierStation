// Small stroke-icon set (24×24 grid). Inline so there is no icon-font request and nothing to tree-shake.
const P: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10',
  reaction: 'M4 8h13m0 0-3-3m3 3-3 3M20 16H7m0 0 3-3m-3 3 3 3',
  pathway: 'M4 5h6v4H4zM14 15h6v4h-6zM7 9v3a2 2 0 0 0 2 2h5M12 14l2 1-2 1',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.500 2.500 3.500 5.500 3.500 9s-1 6.500-3.500 9c-2.500-2.500-3.500-5.500-3.500-9s1-6.500 3.500-9z',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  dna: 'M7 3c0 6 10 6 10 12s-10 6-10 6M17 3c0 6-10 6-10 12M8.5 6.5h7M7.5 12h9M8.5 17.5h7',
  gene: 'M5 4v16M19 4v16M5 8h14M5 16h14M9 8v8M15 8v8',
  protein: 'M6 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm10-4a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 12l4-2m4 3 1.5 5.5M13 20a2 2 0 1 0 0-.01',
  flask: 'M9 3h6M10 3v6l-5.5 9.2A1.5 1.5 0 0 0 5.8 20.5h12.4a1.5 1.5 0 0 0 1.3-2.3L14 9V3M7.5 15h9',
  cube: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-8',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9zM10 20a2 2 0 0 0 4 0',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2-1.2L14.6 3h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7.400 7.400 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7.500 7.500 0 0 0 2 1.2l.4 2.600h4l.4-2.600a7.500 7.500 0 0 0 2-1.200l2.300.900 2-3.400-2-1.500c.1-.4.1-.8.1-1.200z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3-4.5-4.5',
  plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6 6 18', check: 'M5 12.5 10 17.5 19 7', chevR: 'M9 6l6 6-6 6', chevD: 'M6 9l6 6 6-6', chevL: 'M15 6l-6 6 6 6', chevU: 'M6 15l6-6 6 6',
  grid: 'M3.5 4.5h17v15h-17zM3.5 9.5h17M3.5 14.5h17M9 4.5v15', kanban: 'M4 4h5v13H4zM10 4h5v8h-5zM16 4h4v10h-4z', gallery: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', graph: 'M6 7a2 2 0 1 0 0-.01M18 5a2 2 0 1 0 0-.01M17 18a2 2 0 1 0 0-.01M7.700 6.200l8.400-.9M17.500 7.400l-.3 8.600M7 9l8.700 7.800',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z', sort: 'M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3', group: 'M4 5h16M4 10h10M4 15h16M4 20h10', eye: 'M2.500 12S6 5 12 5s9.500 7 9.500 7-3.500 7-9.500 7S2.500 12 2.500 12zM12 14.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5z',
  eyeoff: 'M3 3l18 18M10.600 6.100A9 9 0 0 1 12 6c6 0 9.500 6 9.500 6a16 16 0 0 1-3.100 3.700M6.600 7.600A16 16 0 0 0 2.500 12S6 18 12 18a9 9 0 0 0 3.400-.7M9.900 9.900a2.500 2.500 0 0 0 3.500 3.500',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', copy: 'M9 9h11v11H9zM5 15V4h11', download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14', upload: 'M12 16V5m0 0-4 4m4-4 4 4M5 20h14',
  play: 'M7 4.500v15l12-7.500z', refresh: 'M20 11a8 8 0 0 0-14.500-4M4 4v4h4M4 13a8 8 0 0 0 14.500 4M20 20v-4h-4', link: 'M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.500 3.500-6 8-6s8 2.500 8 6', text: 'M5 6h14M12 6v13M9 19h6', hash: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16', select: 'M4 7h16v10H4zM14 11l2 2 2-2',
  tag: 'M3 12V4h8l10 10-8 8zM7.500 8.500h.01', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2', more: 'M5 12h.01M12 12h.01M19 12h.01', expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7', ext: 'M14 4h6v6M20 4 10 14M18 14v5H5V6h5',
  alert: 'M12 3 2 20h20zM12 10v4M12 17.500h.01', info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.500h.01', sidebar: 'M4 5h16v14H4zM9 5v14', menu: 'M4 7h16M4 12h16M4 17h16', formula: 'M7 5h10M7 19h10M8 5l8 14M16 5 8 19', paperclip: 'M20 11.500 12 19.500a5 5 0 0 1-7-7l8-8a3.500 3.500 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7',
  lookup: 'M3 6h7v5H3zM14 13h7v5h-7zM10 8.500h3a2 2 0 0 1 2 2V13', book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11', beaker: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.800 3h10.400a2 2 0 0 0 1.800-3l-5-9V3', leaf: 'M5 19c0-9 5-14 15-14 0 10-5 15-14 15M5 19l7-7',
  sequence: 'M4 8h2M9 8h2M14 8h2M19 8h1M4 12h1M8 12h3M14 12h2M19 12h1M4 16h2M9 16h1M13 16h3M19 16h1', pdb: 'M12 3 4 7.500v9L12 21l8-4.500v-9zM12 12 4 7.500M12 12l8-4.500M12 12v9', star: 'M12 3.500l2.700 5.500 6 .9-4.400 4.200 1 6-5.300-2.800-5.400 2.800 1-6L3.300 9.900l6-.9z',
};
export type IconName = keyof typeof P | string;
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
      <path d={P[name] ?? P.info} />
    </svg>
  );
}

export const KIND_ICON: Record<string, string> = { reaction: 'reaction', pathway: 'pathway', dna: 'dna', rna: 'dna', gene: 'gene', protein: 'protein', chemical: 'flask', structure: 'cube', organism: 'leaf', publication: 'book', experiment: 'beaker', analysis: 'chart', task: 'check', custom: 'grid', job: 'bolt' };
export const FIELD_ICON: Record<string, string> = {
  text: 'text', longtext: 'text', number: 'hash', singleSelect: 'select', multiSelect: 'tag', status: 'star', checkbox: 'check', url: 'link', attachment: 'paperclip', formula: 'formula', relation: 'link', lookup: 'lookup', rollup: 'lookup',
  sequence: 'sequence', structure: 'cube', date: 'calendar', createdTime: 'clock', lastModifiedTime: 'clock', user: 'user',
};
