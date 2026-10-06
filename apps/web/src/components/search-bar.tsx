import { SearchIcon } from "./icons";

export function SearchBar({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string | undefined;
}) {
  return (
    <div className={`search-bar ${className}`.trim()}>
      <SearchIcon className="search-bar__icon" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="search-bar__input"
      />
      {value ? (
        <button
          type="button"
          className="search-bar__clear"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
