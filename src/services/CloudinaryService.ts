import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadFromUrl = async (url: string, publicId: string): Promise<string | null> => {
    try {
        const result = await cloudinary.uploader.upload(url, {
            folder: "calocare",
            public_id: publicId,
            overwrite: false,
            fetch_format: "auto",
            quality: "auto",
        });
        return result.secure_url;
    } catch (err) {
        console.warn("[CloudinaryService] Upload failed:", err instanceof Error ? err.message : String(err));
        return null;
    }
};

// Checks whether a URL is already hosted on Cloudinary
export const isCloudinaryUrl = (url: string): boolean =>
    url.includes("res.cloudinary.com");
