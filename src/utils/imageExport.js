/**
 * 将 Canvas 导出为 PNG，通过浏览器下载保存。
 * 保持现有调用方式；异步编码失败由本工具提示，调用方无需改动。
 * @param {HTMLCanvasElement} canvas - canvas 元素
 * @param {string} filename - PNG 文件名
 */
export const downloadCanvasAsImage = (canvas, filename) => {
  // DIRECT_PNG_DOWNLOAD_V1: 导出按钮只触发下载，不调用系统分享。
  try {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((blob) => {
        if (!blob) {
          fallbackToDataURL(canvas, filename);
          return;
        }

        // toBlob 回调异步执行，必须在回调内部捕获下载异常。
        try {
          downloadBlob(blob, filename);
        } catch (error) {
          console.error("Blob 下载失败，尝试 PNG 数据链接:", error);
          fallbackToDataURL(canvas, filename);
        }
      }, "image/png");
    } else {
      fallbackToDataURL(canvas, filename);
    }
  } catch (error) {
    console.error("Canvas 编码失败，尝试 PNG 数据链接:", error);
    fallbackToDataURL(canvas, filename);
  }
};

const downloadUrl = (url, filename) => {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    document.body.removeChild(link);
  }
};

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  try {
    downloadUrl(url, filename);
  } finally {
    // 给浏览器读取大图的时间，避免原先 100ms 后过早释放链接。
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
};

const fallbackToDataURL = (canvas, filename) => {
  try {
    const imgUrl = canvas.toDataURL("image/png");
    // 零尺寸或超过浏览器尺寸上限时可能得到 data:,，不能当作 PNG 下载。
    if (!imgUrl.startsWith("data:image/png")) {
      throw new Error("Canvas 未生成有效的 PNG 数据");
    }
    downloadUrl(imgUrl, filename);
  } catch (error) {
    console.error("PNG 导出失败:", error);
    alert("导出图片失败，图片可能过大或含无法导出的跨域图片，请重试");
  }
};
