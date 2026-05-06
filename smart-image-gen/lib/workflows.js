// Bundled ComfyUI workflow templates (inlined so the extension doesn't
// need filesystem access). Mirrored from g:/本地部署/*.txt — keep in sync.
//
// Placeholders (%prompt%, %negative_prompt%, %width%, %height%, %steps%, %denoise%)
// are overwritten programmatically by ComfyUIBridge.generate.

export const workflowTemplates = {
    pony: {
        "1": { "inputs": { "ckpt_name": "ponyRealism_V22.safetensors", "clip_skip": "2" }, "class_type": "CheckpointLoaderSimple" },
        "2": { "inputs": { "model": ["1", 0], "clip": ["1", 1], "lora_name": "Pony\\zy_Realism_Enhancer_v2.safetensors", "strength_model": 0.7, "strength_clip": 0.7 }, "class_type": "LoraLoader" },
        "3": { "inputs": { "model": ["2", 0], "clip": ["2", 1], "lora_name": "Pony\\zy_AmateurStyle_v2.safetensors", "strength_model": 0.6, "strength_clip": 0.6 }, "class_type": "LoraLoader" },
        "6": { "inputs": { "model": ["3", 0], "object_to_patch": "diffusion_model", "residual_diff_threshold": 0.15, "start": 0.2, "end": 0.8, "max_consecutive_cache_hits": 5 }, "class_type": "ApplyFBCacheOnModel" },
        "7": { "inputs": { "clip": ["3", 1], "text": "%prompt%" }, "class_type": "CLIPTextEncode" },
        "8": { "inputs": { "clip": ["3", 1], "text": "%negative_prompt%" }, "class_type": "CLIPTextEncode" },
        "9": { "inputs": { "width": 832, "height": 1216, "batch_size": 1 }, "class_type": "EmptyLatentImage" },
        "10": { "inputs": { "model": ["6", 0], "positive": ["7", 0], "negative": ["8", 0], "latent_image": ["9", 0], "seed": 0, "steps": 30, "cfg": 6.5, "sampler_name": "dpmpp_2m_sde", "scheduler": "karras", "denoise": 1.0 }, "class_type": "KSampler" },
        "11": { "inputs": { "samples": ["10", 0], "vae": ["1", 2] }, "class_type": "VAEDecode" },
        "30": { "inputs": { "model_name": "bbox/face_yolov8m.pt" }, "class_type": "UltralyticsDetectorProvider" },
        "31": { "inputs": { "image": ["11", 0], "model": ["6", 0], "clip": ["3", 1], "vae": ["1", 2], "guide_size": 512.0, "guide_size_for": true, "max_size": 1024.0, "seed": 12345, "steps": 20, "cfg": 6.5, "sampler_name": "dpmpp_2m_sde", "scheduler": "karras", "positive": ["7", 0], "negative": ["8", 0], "denoise": 0.45, "feather": 5, "noise_mask": true, "force_inpaint": true, "bbox_threshold": 0.5, "bbox_dilation": 10, "bbox_crop_factor": 3.0, "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0, "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False", "drop_size": 10, "bbox_detector": ["30", 0], "wildcard": "", "cycle": 1 }, "class_type": "FaceDetailer" },
        "27": { "inputs": { "model_name": "RealESRGAN_x2plus.pth" }, "class_type": "UpscaleModelLoader" },
        "28": { "inputs": { "upscale_model": ["27", 0], "image": ["31", 0] }, "class_type": "ImageUpscaleWithModel" },
        "12": { "inputs": { "images": ["28", 0], "filename_prefix": "PonyRealism_2K" }, "class_type": "SaveImage" }
    },

    noobai: {
        "1":   { "inputs": { "ckpt_name": "noobaiXLNAIXL_vPred10Version.safetensors", "clip_skip": "2" }, "class_type": "CheckpointLoaderSimple" },
        "100": { "inputs": { "model": ["1", 0], "sampling": "v_prediction", "zsnr": true }, "class_type": "ModelSamplingDiscrete" },
        // RescaleCFG 0.7 — mandatory for NoobAI vPred to fix dark/underexposed output
        "101": { "inputs": { "model": ["100", 0], "multiplier": 0.7 }, "class_type": "RescaleCFG" },
        "2":   { "inputs": { "model": ["101", 0], "clip": ["1", 1], "lora_name": "NoobAI-XL (NAI-XL)的LoRA_动漫风格\\NOOB_vp1_detailer_v1.safetensors", "strength_model": 0.5, "strength_clip": 0.5 }, "class_type": "LoraLoader" },
        "6":   { "inputs": { "model": ["2", 0], "object_to_patch": "diffusion_model", "residual_diff_threshold": 0.15, "start": 0.2, "end": 0.8, "max_consecutive_cache_hits": 5 }, "class_type": "ApplyFBCacheOnModel" },
        "7":   { "inputs": { "clip": ["2", 1], "text": "%prompt%" }, "class_type": "CLIPTextEncode" },
        "8":   { "inputs": { "clip": ["2", 1], "text": "%negative_prompt%" }, "class_type": "CLIPTextEncode" },
        "9":   { "inputs": { "width": 832, "height": 1216, "batch_size": 1 }, "class_type": "EmptyLatentImage" },
        "10":  { "inputs": { "model": ["6", 0], "positive": ["7", 0], "negative": ["8", 0], "latent_image": ["9", 0], "seed": 0, "steps": 30, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0 }, "class_type": "KSampler" },
        "11":  { "inputs": { "samples": ["10", 0], "vae": ["1", 2] }, "class_type": "VAEDecode" },
        "30":  { "inputs": { "model_name": "bbox/face_yolov8m.pt" }, "class_type": "UltralyticsDetectorProvider" },
        "31":  { "inputs": { "image": ["11", 0], "model": ["6", 0], "clip": ["2", 1], "vae": ["1", 2], "guide_size": 512.0, "guide_size_for": true, "max_size": 1024.0, "seed": 12345, "steps": 20, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal", "positive": ["7", 0], "negative": ["8", 0], "denoise": 0.45, "feather": 5, "noise_mask": true, "force_inpaint": true, "bbox_threshold": 0.5, "bbox_dilation": 10, "bbox_crop_factor": 3.0, "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0, "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False", "drop_size": 10, "bbox_detector": ["30", 0], "wildcard": "", "cycle": 1 }, "class_type": "FaceDetailer" },
        "27":  { "inputs": { "model_name": "RealESRGAN_x2plus.pth" }, "class_type": "UpscaleModelLoader" },
        "28":  { "inputs": { "upscale_model": ["27", 0], "image": ["31", 0] }, "class_type": "ImageUpscaleWithModel" },
        "12":  { "inputs": { "images": ["28", 0], "filename_prefix": "Noobai_2K" }, "class_type": "SaveImage" }
    },

    majicmix: {
        "1": { "inputs": { "ckpt_name": "majicmixRealistic_v7.safetensors", "clip_skip": "2" }, "class_type": "CheckpointLoaderSimple" },
        "7": { "inputs": { "clip": ["1", 1], "text": "%prompt%" }, "class_type": "CLIPTextEncode" },
        "8": { "inputs": { "clip": ["1", 1], "text": "%negative_prompt%" }, "class_type": "CLIPTextEncode" },
        "9": { "inputs": { "width": 768, "height": 1152, "batch_size": 1 }, "class_type": "EmptyLatentImage" },
        "10": { "inputs": { "model": ["1", 0], "positive": ["7", 0], "negative": ["8", 0], "latent_image": ["9", 0], "seed": 0, "steps": 30, "cfg": 7.0, "sampler_name": "euler_ancestral", "scheduler": "karras", "denoise": 1.0 }, "class_type": "KSampler" },
        "11": { "inputs": { "samples": ["10", 0], "vae": ["1", 2] }, "class_type": "VAEDecode" },
        "30": { "inputs": { "model_name": "bbox/face_yolov8m.pt" }, "class_type": "UltralyticsDetectorProvider" },
        "31": { "inputs": { "image": ["11", 0], "model": ["1", 0], "clip": ["1", 1], "vae": ["1", 2], "guide_size": 384.0, "guide_size_for": true, "max_size": 768.0, "seed": 12345, "steps": 20, "cfg": 7.0, "sampler_name": "euler_ancestral", "scheduler": "karras", "positive": ["7", 0], "negative": ["8", 0], "denoise": 0.4, "feather": 5, "noise_mask": true, "force_inpaint": true, "bbox_threshold": 0.5, "bbox_dilation": 10, "bbox_crop_factor": 3.0, "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0, "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False", "drop_size": 10, "bbox_detector": ["30", 0], "wildcard": "", "cycle": 1 }, "class_type": "FaceDetailer" },
        "27": { "inputs": { "model_name": "RealESRGAN_x2plus.pth" }, "class_type": "UpscaleModelLoader" },
        "28": { "inputs": { "upscale_model": ["27", 0], "image": ["31", 0] }, "class_type": "ImageUpscaleWithModel" },
        "12": { "inputs": { "images": ["28", 0], "filename_prefix": "Majic_2K" }, "class_type": "SaveImage" }
    },
};
