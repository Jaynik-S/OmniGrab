/** A silent dedicated-worker exit does not reliably emit an error event. */
export function watchWorker(onLost: () => void, idleMs = 15_000) {
 let timer: ReturnType<typeof setTimeout> | undefined;
 const beat=()=>{clearTimeout(timer);timer=setTimeout(onLost,idleMs);};beat();
 return {beat,dispose(){clearTimeout(timer);}};
}
