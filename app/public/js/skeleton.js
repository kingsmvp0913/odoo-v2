// 共用載入骨架，取代純文字「載入中...」造成的閃白。
// 用法：<Skeleton width="120px" /> 或 <Skeleton width="60%" height="20px" />
window.Skeleton = {
  name: 'Skeleton',
  props: {
    width: { type: String, default: '100%' },
    height: { type: String, default: '14px' },
    radius: { type: String, default: '' }
  },
  template: `<span class="skeleton" :style="{ width, height, borderRadius: radius || undefined }"></span>`
};
