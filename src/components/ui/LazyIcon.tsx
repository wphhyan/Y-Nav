import React from 'react';
import { resolveIconUrl } from '../../utils/iconUrl';
import { useInViewOnce } from '../../hooks/useInViewOnce';

interface LazyIconProps {
    /** 图标地址；第三方 favicon 服务地址会被自动改写为同源代理地址 */
    src?: string;
    /** 无图标或加载失败时展示的首字母 */
    fallback: string;
    /** 图标盒尺寸类，需与容器保持一致以免布局跳动 */
    sizeClassName?: string;
    alt?: string;
}

/**
 * 懒加载图标。
 *
 * 卡片列表动辄几十个图标，原先 `<img src>` 会在渲染瞬间全部发起请求；
 * 而图标来自第三方服务（实测 1.3s+/个），于是页面 load 之后还会持续变慢。
 * 这里改成：
 * - 进入视口（含 200px 预热）后才真正加载；
 * - 加载前 / 失败后展示首字母占位，不出现破图与布局跳动。
 */
const LazyIcon: React.FC<LazyIconProps> = ({
    src,
    fallback,
    sizeClassName = 'w-5 h-5',
    alt = ''
}) => {
    const { ref, inView } = useInViewOnce<HTMLSpanElement>();
    const [loaded, setLoaded] = React.useState(false);
    const [failed, setFailed] = React.useState(false);

    const url = React.useMemo(() => resolveIconUrl(src), [src]);
    const showImage = Boolean(url) && inView && !failed;

    return (
        <span ref={ref} className={`relative inline-flex items-center justify-center shrink-0 ${sizeClassName}`}>
            {!loaded && (
                <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-slate-400 dark:text-slate-500 uppercase">
                    {fallback}
                </span>
            )}
            {showImage && (
                <img
                    src={url}
                    alt={alt}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className={`${sizeClassName} object-contain`}
                    onLoad={() => setLoaded(true)}
                    onError={() => setFailed(true)}
                />
            )}
        </span>
    );
};

export default LazyIcon;
