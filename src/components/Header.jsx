export function Header({ cefr, reviewing = 147, graduated = 23, currentPage, totalPages }) {
  return (
    <header className="header">
      <span className="level-pill">
        <span className="level-pill__dot" />
        {cefr}
      </span>
      <div className="stats">
        <span className="stat">
          <span className="stat__num">{reviewing}</span> reviewing
        </span>
        <span className="stat">
          <span className="stat__num">{graduated}</span> graduated
        </span>
        <span className="stat">
          <span className="stat__num">{currentPage}</span> / {totalPages}
        </span>
      </div>
    </header>
  );
}
