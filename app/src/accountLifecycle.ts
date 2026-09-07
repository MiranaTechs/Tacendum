/** Shared transport fence, independent of the API/reauth import cycle. */
let generation = 0;
let suspended = false;

export function accountRequestGeneration(): number { return generation; }
export function accountRequestsSuspended(): boolean { return suspended; }

export function suspendAccountRequests(): void {
  generation++;
  suspended = true;
}

export function resumeAccountRequests(): void { suspended = false; }
