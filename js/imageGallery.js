"use strict";
// Reads EXIF metadata (Make, Model, Lens, Focal Length, F-Number, ISO, exposure time) from the
// full-size gallery images and appends it to the visible gallery-caption text.
const EXIF_TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
function readExifIfd(view, tiffStart, ifdOffset, littleEndian) {
    const tags = {};
    const entryCount = view.getUint16(ifdOffset, littleEndian);
    for (let i = 0; i < entryCount; i++) {
        const entryOffset = ifdOffset + 2 + i * 12;
        const tag = view.getUint16(entryOffset, littleEndian);
        const type = view.getUint16(entryOffset + 2, littleEndian);
        const count = view.getUint32(entryOffset + 4, littleEndian);
        const valueOffset = entryOffset + 8;
        const size = (EXIF_TYPE_SIZES[type] || 1) * count;
        const dataOffset = size > 4 ? tiffStart + view.getUint32(valueOffset, littleEndian) : valueOffset;
        if (type === 2) {
            let value = "";
            for (let j = 0; j < count - 1; j++) {
                value += String.fromCharCode(view.getUint8(dataOffset + j));
            }
            tags[tag] = value.trim();
        }
        else if (type === 3) {
            tags[tag] = view.getUint16(dataOffset, littleEndian);
        }
        else if (type === 4) {
            tags[tag] = view.getUint32(dataOffset, littleEndian);
        }
        else if (type === 5) {
            const numerator = view.getUint32(dataOffset, littleEndian);
            const denominator = view.getUint32(dataOffset + 4, littleEndian);
            tags[tag] = denominator === 0 ? 0 : numerator / denominator;
        }
    }
    return tags;
}
function readExifData(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) {
        return null;
    }
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
        const marker = view.getUint16(offset, false);
        if (marker === 0xffd9 || marker === 0xffda) {
            break;
        }
        const size = view.getUint16(offset + 2, false);
        if (marker === 0xffe1 && offset + 10 <= view.byteLength) {
            const exifHeaderOffset = offset + 4;
            const isExifHeader = view.getUint32(exifHeaderOffset, false) === 0x45786966
                && view.getUint16(exifHeaderOffset + 4, false) === 0x0000;
            if (isExifHeader) {
                const tiffStart = exifHeaderOffset + 6;
                const byteOrderMark = view.getUint16(tiffStart, false);
                const littleEndian = byteOrderMark === 0x4949;
                const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
                const ifd0 = readExifIfd(view, tiffStart, tiffStart + ifd0Offset, littleEndian);
                const exif = {
                    make: ifd0[0x010f],
                    model: ifd0[0x0110],
                };
                if (ifd0[0x8769] !== undefined) {
                    const exifIfd = readExifIfd(view, tiffStart, tiffStart + ifd0[0x8769], littleEndian);
                    exif.focalLength = exifIfd[0x920a];
                    exif.fNumber = exifIfd[0x829d];
                    exif.iso = exifIfd[0x8827];
                    exif.exposureTime = exifIfd[0x829a];
                    exif.lens = exifIfd[0xa434];
                }
                return exif;
            }
        }
        offset += 2 + size;
    }
    return null;
}
function roundTo(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}
function formatFocalLength(focalLength) {
    return roundTo(focalLength, 0) + "mm";
}
function formatFNumber(fNumber) {
    return "f/" + roundTo(fNumber, 1);
}
function formatExposureTime(exposureTime) {
    if (exposureTime >= 1) {
        return roundTo(exposureTime, 1) + "s";
    }
    return "1/" + Math.round(1 / exposureTime) + "s";
}
// Some models report internal/marketing codenames instead of their common name;
// map those raw EXIF model substrings to the name customers would recognise.
const MODEL_NAME_OVERRIDES = {
    "IN2023": "8 Pro",
    "M50m2": "M50 Mark II",
};
function applyModelNameOverrides(model) {
    return Object.keys(MODEL_NAME_OVERRIDES).reduce(function (result, rawName) {
        return result.split(rawName).join(MODEL_NAME_OVERRIDES[rawName]);
    }, model);
}
function normalizeModel(make, model) {
    let normalized = model;
    if (make && normalized.indexOf(make) === 0) {
        normalized = normalized.slice(make.length).trim();
    }
    return applyModelNameOverrides(normalized);
}
function buildExifCaptionSuffix(exif) {
    const parts = [];
    const model = exif.model ? normalizeModel(exif.make, exif.model) : undefined;
    if (exif.make && model) {
        parts.push(exif.make + " " + model);
    }
    else if (exif.make) {
        parts.push(exif.make);
    }
    else if (model) {
        parts.push(model);
    }
    if (exif.lens) {
        parts.push(exif.lens);
    }
    if (exif.focalLength) {
        parts.push(formatFocalLength(exif.focalLength));
    }
    if (exif.fNumber) {
        parts.push(formatFNumber(exif.fNumber));
    }
    if (exif.iso) {
        parts.push("ISO " + exif.iso);
    }
    if (exif.exposureTime) {
        parts.push(formatExposureTime(exif.exposureTime));
    }
    if (parts.length === 0) {
        return null;
    }
    return parts.join(", ");
}
function appendExifToCaption(imageSrc, captionElement) {
    fetch(imageSrc)
        .then(function (response) {
        if (!response.ok) {
            throw new Error("Failed to fetch image: " + imageSrc);
        }
        return response.arrayBuffer();
    })
        .then(function (buffer) {
        const exif = readExifData(buffer);
        if (!exif) {
            return;
        }
        const suffix = buildExifCaptionSuffix(exif);
        if (suffix) {
            captionElement.appendChild(document.createElement("br"));
            captionElement.appendChild(document.createTextNode(suffix));
        }
    })
        .catch(function () {
        // EXIF data is a supplementary caption enhancement; ignore failures.
    });
}
function initImageGallery() {
    document.querySelectorAll(".gallery-slide").forEach(function (slide) {
        const image = slide.querySelector("img.slide");
        const caption = slide.querySelector(".gallery-caption");
        if (!image || !caption) {
            return;
        }
        const src = image.getAttribute("src");
        if (!src) {
            return;
        }
        appendExifToCaption(src, caption);
    });
}
document.addEventListener("DOMContentLoaded", initImageGallery);
