/** App logo: a staircase of three joined nodes on a white tile (source artwork in docs/assets/logo.png). */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" className="shrink-0 rounded-[5px] shadow-soft ring-1 ring-border">
      <rect width="100" height="100" rx="20" fill="#fff" />
      <path fill="#0a0a0a" d="M14 73V64A6 6 0 0 1 20 58H31A5 5 0 0 0 36 53V46A6 6 0 0 1 42 40H53A5 5 0 0 0 58 35V26A6 6 0 0 1 64 20H76A6 6 0 0 1 82 26V36A6 6 0 0 1 76 42H64A5 5 0 0 0 59 47V55A6 6 0 0 1 53 61H42A5 5 0 0 0 37 66V73A6 6 0 0 1 31 79H20A6 6 0 0 1 14 73Z" />
    </svg>
  );
}
