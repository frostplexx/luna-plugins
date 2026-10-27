export const mapConcurrent = async <T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
	const results = new Array<R>(items.length);
	const workerCount = Math.min(Math.max(1, limit), items.length);
	let next = 0;

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await fn(items[index], index);
			}
		}),
	);

	return results;
};

export const createLimiter = (limit: number) => {
	let active = 0;
	const waiting: (() => void)[] = [];

	const acquire = async () => {
		if (active < limit) {
			active++;
			return;
		}
		await new Promise<void>((resolve) => waiting.push(resolve));
	};

	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else active--;
	};

	return async <T>(task: () => Promise<T>): Promise<T> => {
		await acquire();
		try {
			return await task();
		} finally {
			release();
		}
	};
};
