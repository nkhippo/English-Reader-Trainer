export function Footer({ onStillHard, onGotIt, hardFlash }) {
  return (
    <footer className="footer">
      <button
        className={`btn btn--ghost ${hardFlash ? 'btn--hard-flash' : ''}`}
        onClick={onStillHard}
      >
        ⊘ Still hard
      </button>
      <button className="btn btn--primary" onClick={onGotIt}>
        Got it →
      </button>
    </footer>
  );
}
