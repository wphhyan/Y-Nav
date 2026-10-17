import { useEffect, useRef, useState } from 'react';

/**
 * 元素首次进入视口（含预热边距）后返回 true，之后不再变化。
 *
 * 所有调用方共用同一个 IntersectionObserver 实例，避免列表里成百上千个卡片
 * 各建一个 observer。
 */
const PRELOAD_MARGIN = '200px 0px';

const callbacks = new WeakMap<Element, () => void>();
let sharedObserver: IntersectionObserver | null = null;

const getSharedObserver = (): IntersectionObserver => {
    if (!sharedObserver) {
        sharedObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const callback = callbacks.get(entry.target);
                callbacks.delete(entry.target);
                sharedObserver?.unobserve(entry.target);
                callback?.();
            }
        }, { rootMargin: PRELOAD_MARGIN });
    }
    return sharedObserver;
};

export const useInViewOnce = <T extends Element>() => {
    const ref = useRef<T | null>(null);
    const [inView, setInView] = useState(false);

    useEffect(() => {
        if (inView) return;
        const element = ref.current;
        if (!element) return;

        // 环境不支持时直接放行，避免图标永远不加载
        if (typeof IntersectionObserver === 'undefined') {
            setInView(true);
            return;
        }

        const callback = () => setInView(true);
        callbacks.set(element, callback);
        const observer = getSharedObserver();
        observer.observe(element);

        return () => {
            callbacks.delete(element);
            observer.unobserve(element);
        };
    }, [inView]);

    return { ref, inView };
};

export default useInViewOnce;
