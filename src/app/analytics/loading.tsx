export default function LoadingAnalytics() {
  return <main className="mx-auto max-w-[1240px] animate-pulse p-4 lg:p-7"><div className="mb-6 h-9 w-48 rounded-lg bg-[var(--fill)]"/><div className="mb-6 h-32 rounded-2xl bg-[var(--fill-2)]"/><div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="h-32 rounded-2xl bg-[var(--fill-2)]"/>)}</div></main>;
}
