import React from "react";

/**
 * TopMenu: the standardized right side of the shell bar for every -LAB app.
 * Owner-approved layout (2026-11-11): three right-aligned control rows, brand + nav on
 * the top line at the left; Sign in stands alone in a centered slot on the top line.
 * Owner-approved order, each control prop-gated — a lab that does not
 * need one simply omits the prop and it renders nothing; the order of the rest
 * never changes:
 *
 *   1. mode      Mock/Real dropdown (accent-filled so it stands out), wired to /api/mode
 *   2. vertical  industry selector (where the lab has verticals)
 *   3. theme     Light / Dark / Auto dropdown
 *   4. fontSize  S / M / L dropdown + A- / A+ steppers (percent-based root font size)
 *   5. present      presenter-mode toggle (where the lab has it)
 *   6. talkTrack    talk-track/script toggle (owner 2026-11-11: kept separate from Present
 *                   even where Present shows the script; render only where a script exists)
 *   7. shelf        ShelfLink back to the demo shelf (rendered by the app or via shelfUrl)
 *   8. help         link to the lab's documentation (where the lab has docs)
 *   9. version      About/version button (from the lab's VERSION file)
 *   10. reset       Reset action
 *   11. signIn      Sign in/out — the bar's one primary; shows when `showSignIn` is true
 *                   (pass `real && needsAuth`) plus an optional signed-in display
 *   +  extra        lab-specific controls ride at the end with the same chrome
 *
 * State (theme, fontSize) lives in the app; TopMenu is controlled, so tests keep
 * driving the same state. Styles come from the vendored top-menu.css.
 *
 * Props:
 *   mode             { value: 'mock'|'real', onChange(v), realAvailable, realHint } — omit for mock-only labs
 *   vertical         { value, onChange, options: [ids] } — omit when the lab has no verticals
 *   theme            { value: 'auto'|'light'|'dark', onChange }
 *   fontSize         { value: 'S'|'M'|'L', onChange } — S/M/L map to 14/16/18px root
 *   present         { active, onToggle, label='Present (P)' } — omit when the lab has no presenter mode
 *   talkTrack       { active, onToggle } — omit when the lab has no presenter script
 *   shelfUrl        optional; when given renders the Shelf link, otherwise pass your own <ShelfLink/> via children
 *   help            { href, onClick? } — link to the lab's documentation; omit when there are no docs
 *   version         string — About/version button label (e.g. "v1.4.2", from the lab's VERSION file); omit when unknown
 *   onReset          fn; when given renders the Reset button
 *   showSignIn       bool — true only when Real mode is active and the lab needs auth
 *   signedIn         { subject, onSignIn, onSignOut } — when signed in shows "Signed in as <subject>" + Sign out
 *   extra            optional node (lab-specific buttons, workspace switch, …)
 *   children         optional node rendered at the very end (e.g. an existing <ShelfLink/>)
 */
const FONT_STEPS = { S: "14px", M: "16px", L: "18px" };
export const applyFontSize = (step) => {
  const px = FONT_STEPS[step] || FONT_STEPS.M;
  document.documentElement.style.setProperty("--fs", px);
};

export default function TopMenu({
  mode,
  vertical,
  theme,
  fontSize,
  present,
  talkTrack,
  shelfUrl,
  help,
  version,
  onReset,
  showSignIn = false,
  signedIn,
  extra,
  children,
}) {
  const themeValue = theme?.value ?? "auto";
  const fontValue = fontSize?.value ?? "M";
  return (
    <span className="top-menu shell-right" data-testid="top-menu">
      {/* Sign in stands alone: the app shell centers this slot on the bar's top line */}
      {showSignIn && signedIn && (signedIn.subject
        ? (
          <span className="top-menu__signin-slot top-menu__ctl">
            Signed in as <strong data-testid="who">{signedIn.subject}</strong>
            <button type="button" onClick={signedIn.onSignOut} data-testid="sign-out">Sign out</button>
          </span>
        )
        : (
          <span className="top-menu__signin-slot">
            <button type="button" className="top-menu__signin" onClick={signedIn.onSignIn} data-testid="sign-in">Sign in</button>
          </span>
        ))}
      {/* row 1 */}
      <span className="top-menu__row">
        {mode && (
          <label className="top-menu__ctl top-menu__theme">
            Mode
            <select
              className="top-menu__mode"
              aria-label="Mock or Real"
              data-testid="mode-select"
              value={mode.value}
              onChange={(e) => mode.onChange(e.target.value)}
            >
              <option value="mock">Mock</option>
              <option
                value="real"
                disabled={mode.realAvailable === false}
                title={mode.realAvailable === false ? (mode.realHint || "Real is not configured. Mock keeps working.") : undefined}
              >
                Real
              </option>
            </select>
          </label>
        )}
        {vertical && vertical.options?.length > 0 && (
          <label className="top-menu__ctl">
            Vertical
            <select aria-label="Vertical" data-testid="vertical-select" value={vertical.value} onChange={(e) => vertical.onChange(e.target.value)}>
              {vertical.options.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        )}
        {present && (
          <button type="button" aria-pressed={present.active} data-testid="presenter" onClick={present.onToggle}>
            {present.active ? "Exit present (Esc)" : (present.label || "Present (P)")}
          </button>
        )}
      </span>
      {/* row 2 */}
      <span className="top-menu__row">
      {talkTrack && (
        <button type="button" aria-pressed={talkTrack.active} data-testid="talk-track-toggle" title="Show the presenter script alongside the page" onClick={talkTrack.onToggle}>
          Talk track
        </button>
      )}
        {shelfUrl && (
          <a className="top-menu__shelf" href={shelfUrl} target="_blank" rel="noreferrer" title="Open the demo shelf (launcher)" data-testid="shelf-link">
            Shelf
          </a>
        )}
        {help && (
          <a className="top-menu__shelf" href={help.href} onClick={help.onClick} target="_blank" rel="noreferrer" title="Open this lab's documentation" data-testid="help-link">
            Help
          </a>
        )}
        {version && (
          <button type="button" data-testid="version" title="About this lab">{version}</button>
        )}
        {onReset && (
          <button type="button" data-testid="reset" onClick={onReset}>Reset</button>
        )}
      </span>
      {/* row 3: theme + text size */}
      <span className="top-menu__row">
        {theme && (
          <label className="top-menu__ctl top-menu__theme">
            Theme
            <select aria-label="Theme" data-testid="theme-select" value={themeValue} onChange={(e) => theme.onChange(e.target.value)}>
              <option value="auto">Auto</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        )}
        {fontSize && (
          <>
            <label className="top-menu__ctl">
              Text size
              <select aria-label="Font size" data-testid="font-select" value={fontValue} onChange={(e) => fontSize.onChange(e.target.value)}>
                <option value="S">S</option>
                <option value="M">M</option>
                <option value="L">L</option>
              </select>
            </label>
            <span role="group" aria-label="Font size stepper" data-testid="font-stepper">
              <button type="button" aria-label="Smaller text" disabled={fontValue === "S"} onClick={() => fontSize.onChange(fontValue === "L" ? "M" : "S")}>A−</button>
              <button type="button" aria-label="Larger text" disabled={fontValue === "L"} onClick={() => fontSize.onChange(fontValue === "M" ? "L" : "M")}>A+</button>
            </span>
          </>
        )}
      </span>
      {extra && <span className="top-menu__extra">{extra}</span>}
      {children}
    </span>
  );
}
