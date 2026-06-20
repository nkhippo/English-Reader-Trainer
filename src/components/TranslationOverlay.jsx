export function TranslationOverlay({ text, visible }) {
  return (
    <div className={`translation-overlay ${visible ? 'is-visible' : ''}`}>{text}</div>
  );
}
