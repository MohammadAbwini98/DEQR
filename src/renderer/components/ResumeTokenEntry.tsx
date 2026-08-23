import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  RESUME_TOKEN_CHARS,
  RESUME_TOKEN_GROUP,
  decodeResumeToken,
  type ResumeTokenErrorCode,
} from '../../core/resume-token';

/**
 * The screen Phase 07 left open.
 *
 * Phase 07 built a forty-character code that lets a sender restart where a
 * receiver actually stopped, and a receiver that displays one. Nothing on the
 * desktop could accept it, so the mechanism existed and the feature did not.
 *
 * The code crosses an air gap in a person's short-term memory or on a piece of
 * paper, which is the whole reason it is Crockford base32 with a checksum: the
 * alphabet folds I, L and O onto 1, 1 and 0, and the checksum catches the
 * typos the alphabet cannot. Both properties are used here rather than left to
 * the main process, so a mistyped character is named on this screen instead of
 * opening a file dialog that will fail afterwards.
 *
 * What this screen does *not* do is decide whether the token belongs to the
 * file. It cannot - the digest prefix is only meaningful against the bytes on
 * disk - so a structurally valid token still has to be checked by the main
 * process against the file the user then picks, and that refusal comes back
 * here with its own message.
 */

interface Props {
  onSubmit: (token: string) => void;
  onCancel: () => void;
  /** A refusal from a previous attempt, already made readable. */
  rejection: string | null;
  busy: boolean;
}

/**
 * What each decode failure means to the person who typed it.
 *
 * Codes are not shown. A code is the right thing to log and the wrong thing to
 * read, and every one of these has a different next action - retype, check the
 * screen, or stop trying because the two builds disagree.
 */
const DECODE_MESSAGE: Readonly<Record<ResumeTokenErrorCode, string>> = {
  RESUME_TOKEN_LENGTH: `A resume code is ${RESUME_TOKEN_CHARS} characters. Check that none were missed at the end.`,
  RESUME_TOKEN_CHARSET: 'That code contains a character a resume code never uses. Check for a mistyped letter.',
  RESUME_TOKEN_CHECKSUM: 'That code does not check out — almost always a single mistyped character. Compare it with the phone again.',
  RESUME_TOKEN_VERSION: 'That code was made by a different version of DEQR. Both devices need the same build to resume.',
  RESUME_TOKEN_RANGE: 'That code describes a restart point past the end of its own transfer. Start the transfer again from the beginning.',
};

/** Renders the code in the same five-character groups the receiver shows it in. */
function group(raw: string): string {
  const groups: string[] = [];
  for (let at = 0; at < raw.length; at += RESUME_TOKEN_GROUP) {
    groups.push(raw.slice(at, at + RESUME_TOKEN_GROUP));
  }
  return groups.join('-');
}

export default function ResumeTokenEntry({ onSubmit, onCancel, rejection, busy }: Props) {
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Separators are display sugar; the codec strips them. Normalising on the way
  // in means the field accepts a code however it was transcribed - with spaces,
  // with hyphens, in lower case - and shows one consistent shape back.
  const cleaned = useMemo(() => raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, RESUME_TOKEN_CHARS), [raw]);
  const complete = cleaned.length === RESUME_TOKEN_CHARS;
  const decoded = useMemo(() => (complete ? decodeResumeToken(cleaned) : null), [cleaned, complete]);
  const decodeError = decoded && !decoded.ok ? DECODE_MESSAGE[decoded.code] : null;
  // Held back until the field is full, so the message is not an error about
  // something the user is still in the middle of typing.
  const message = decodeError ?? rejection;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!decoded?.ok) return;
    onSubmit(cleaned);
  };

  return (
    <section className="resume-entry" aria-labelledby="resume-heading">
      <div className="section-heading">
        <p className="eyebrow">Resume transfer</p>
        <h1 id="resume-heading" data-screen-heading tabIndex={-1}>Enter the resume code</h1>
        <p>
          The receiving device shows a {RESUME_TOKEN_CHARS}-character code for a transfer it has partly
          received. Type it here, then choose the same file again — the transfer restarts where the
          receiver stopped instead of from the beginning.
        </p>
      </div>

      <form className="resume-form" onSubmit={submit}>
        <label htmlFor="resume-token">Resume code</label>
        <input
          id="resume-token"
          ref={inputRef}
          className="monospace resume-input"
          value={group(cleaned)}
          onChange={(event) => setRaw(event.target.value)}
          onBlur={() => setTouched(true)}
          // Not a password field, but every one of these is wrong for a code
          // transcribed off another screen.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
          aria-describedby="resume-progress resume-message"
          aria-invalid={Boolean(decodeError)}
          disabled={busy}
        />
        <p id="resume-progress" className="resume-progress">
          {cleaned.length} of {RESUME_TOKEN_CHARS} characters
        </p>

        {/* One live region for both failure paths. It speaks only when the
            field is full or the main process has answered, so it does not
            narrate typing. */}
        <p id="resume-message" className="resume-message" role="alert">
          {(touched || complete) && message ? message : ''}
        </p>

        <div className="action-row">
          <button type="submit" className="primary" disabled={busy || !decoded?.ok}>
            {busy ? 'Opening file picker…' : 'Choose the file to resume'}
          </button>
          <button type="button" className="tertiary" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </form>

      <aside className="resume-help">
        <p>
          <strong>Nothing is sent by entering a code.</strong> It tells this device which segment to start
          from. The file is read from this machine as usual, and the receiver still verifies the whole
          file&apos;s SHA-256 before offering to save it.
        </p>
      </aside>
    </section>
  );
}
