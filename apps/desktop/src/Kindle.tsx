import { useCallback, useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { native, loadKindleConfig, KINDLE_KEY, type KindleConfig } from './native';

/**
 * Send a whole book to Kindle.
 *
 * Whole book only — never chapters. Amazon turns one file into one library
 * entry, so a split book would arrive as dozens of unrelated "books". The
 * chapters exist for reading and for agents on this machine; the Kindle gets
 * the book as its author published it.
 *
 * Two routes, because one needs no credentials:
 *   Web uploader — opens Amazon's page and reveals the file to drag. Nothing stored.
 *   E-mail       — needs an app password, kept in the OS keyring. Fully automatic.
 */

interface Props {
  bookPath: string;
  bookTitle: string;
  onDone: (message: string) => void;
  onClose: () => void;
}

export function KindleDialog({ bookPath, bookTitle, onDone, onClose }: Props) {
  const [config, setConfig] = useState<KindleConfig>(loadKindleConfig);
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { void native.hasKindlePassword().then(setHasPassword); }, []);

  const persist = useCallback((next: KindleConfig) => {
    setConfig(next);
    localStorage.setItem(KINDLE_KEY, JSON.stringify(next));
  }, []);

  const send = useCallback(async () => {
    setError(''); setBusy('Sending…');
    try {
      if (password.trim()) {
        await native.saveKindlePassword(password.trim());
        setPassword('');
        setHasPassword(true);
      }
      onDone(await native.sendToKindle(bookPath, config));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [bookPath, config, onClose, onDone, password]);

  const viaUploader = useCallback(async () => {
    await revealItemInDir(bookPath);
    await openUrl('https://www.amazon.com/sendtokindle');
    onDone('Opened Amazon’s uploader and revealed the file — drag it in.');
    onClose();
  }, [bookPath, onClose, onDone]);

  const ready = config.to.includes('@kindle.') && config.from.includes('@')
    && (hasPassword || password.trim().length > 0);

  return (
    <div className="note-popup" role="dialog" onClick={onClose}>
      <div className="note-popup-inner wide" onClick={(e) => e.stopPropagation()}>
        <div className="pane-head">
          Send to Kindle<span className="spacer" />
          <button className="btn ghost tiny" onClick={onClose}>Close</button>
        </div>

        <div className="kindle-body">
          <p className="sub">
            Sends <strong>{bookTitle}</strong> whole. Chapters stay here — Amazon would
            turn each one into a separate book.
          </p>

          <div className="field">
            <label>No setup needed</label>
            <button className="btn" onClick={() => void viaUploader()}>
              Open Amazon’s uploader and reveal the file
            </button>
            <p className="hint">Drag the file in. Nothing is stored, no password needed.</p>
          </div>

          <div className="field">
            <label>Or send by e-mail, automatically</label>
            <input type="text" placeholder="your-device@kindle.com" value={config.to}
                   onChange={(e) => persist({ ...config, to: e.target.value.trim() })} />
            <input type="text" placeholder="sender address (must be approved by Amazon)"
                   value={config.from} style={{ marginTop: 6 }}
                   onChange={(e) => persist({ ...config, from: e.target.value.trim() })} />
            <div className="row" style={{ marginTop: 6 }}>
              <input type="text" placeholder="smtp host" value={config.host}
                     onChange={(e) => persist({ ...config, host: e.target.value.trim() })} />
              <input type="number" placeholder="port" value={config.port} style={{ maxWidth: 90 }}
                     onChange={(e) => persist({ ...config, port: Number(e.target.value) || 587 })} />
            </div>
            <input type="password" style={{ marginTop: 6 }}
                   placeholder={hasPassword ? 'app password saved in the system keyring' : 'app password'}
                   value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="hint">
              An <em>app password</em>, not your account password. Stored in your
              operating system’s keyring — never in a file, never in this project.
              {hasPassword && (
                <> {' '}
                  <button className="btn ghost tiny" onClick={() => void native.forgetKindlePassword().then(() => setHasPassword(false))}>
                    Forget it
                  </button>
                </>
              )}
            </p>
            <p className="hint">
              The sender must be on Amazon’s <em>Approved Personal Document E-mail List</em>,
              or Amazon discards the message without telling you.
            </p>
          </div>

          {error && <div className="banner error">{error}</div>}

          <div className="row" style={{ marginTop: 4 }}>
            <span className="spacer" />
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!ready || busy !== ''} onClick={() => void send()}>
              {busy || 'Send book'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
