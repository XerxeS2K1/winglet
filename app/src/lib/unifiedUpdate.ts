import Constants from 'expo-constants';
import type { InstallOutcome } from './appInstall';
import { type AppUpdate } from './appUpdate';
import { compareVersions } from './version';

export type UpdateDeps = {
  /** Ask the phone owner to approve this update. Resolves false when they cancel or the lock refuses. */
  authenticate: (prompt: string) => Promise<boolean>;
  /** Download the APK and hand it to Android's installer. */
  install: (update: AppUpdate, eligible: () => boolean) => Promise<InstallOutcome>;
  /** The message the installer left behind, so a failed download can say download, not installer. */
  lastError: () => string;
};

/**
 * The whole phone-side update: authenticate, download the APK, open Android's installer.
 *
 * It knows nothing about the server. The server updates itself; the phone only updates itself.
 */
export class AppUpdateFlow {
  working = false;
  error = '';
  private epoch = 0;
  private readonly deps: UpdateDeps;
  private listeners = new Set<() => void>();

  constructor(deps: UpdateDeps) {
    this.deps = deps;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Cancel any update whose authorization is still in flight. */
  invalidate(): void {
    this.epoch += 1;
  }

  clearError(): void {
    if (!this.error) return;
    this.error = '';
    this.emit();
  }

  /**
   * Start one update. The stale-offer guard is deliberately here as well as in the UI: a release that is
   * not newer than the running build is not an offer, even if it was saved before the build changed.
   */
  async start(update: AppUpdate, visible: () => boolean = () => true,
              current: string = Constants.expoConfig?.version ?? ''): Promise<InstallOutcome | null> {
    if (this.working) return null;
    this.working = true;
    this.error = '';
    this.emit();
    const epoch = ++this.epoch;
    const eligible = () => epoch === this.epoch && visible();
    try {
      if (!update.version || (current && compareVersions(update.version, current) <= 0)) {
        throw new Error('That release is not newer than the build you are running.');
      }
      if (!(await this.deps.authenticate('Update Winglet'))) {
        throw new Error('The update needs your approval before it can start. Try again.');
      }
      if (!eligible()) return null;
      const outcome = await this.deps.install(update, eligible);
      if (outcome === 'error' && !this.error) {
        this.error = this.deps.lastError() || "Couldn't download the update. Check your connection and try again.";
      }
      return outcome;
    } catch (e) {
      if (eligible()) this.error = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      this.working = false;
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
