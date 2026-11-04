"""Anchor-free H3 recipes. Source geometry is measured after 24 fps normalization."""
import math

VERSION = 'opencast-alisson-v1'
SWAP_LORA = 'minimax_h3_character_swap_v1.1_ref2va_fro.safetensors'
MOTION_LORA = 'minimax_h3_motion_transfer_tara_v1.0_ref2va.safetensors'
TURBO = 'minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors'


def geometry(width, height, source_frames, quality):
    if source_frames < 5:
        raise ValueError('At least five source frames are required.')
    pixels = 1_000_000 if quality == '720p' else 500_000
    scale = math.sqrt(pixels / (width * height))
    return max(32, round(width * scale / 32) * 32), max(32, round(height * scale / 32) * 32), 5 + (min(source_frames, 360) - 5) // 17 * 17


def build(kind, parameters, width, height, source_frames, background=False, audio=False):
    swap = kind == 'character-swap'
    if kind not in ('character-swap', 'motion-transfer'):
        raise ValueError('Unknown motion mode')
    width, height, length = geometry(width, height, source_frames, parameters['quality'])
    target = parameters.get('prompt', '').strip()
    details = parameters.get('characterDescription', '').strip() or 'replacement character'
    if swap:
        prompt = f'body_swap: subject_definitions: <Subject 1> is the {details} shown in <Picture 1>, whose identity, face, head, hair or fur, skin, body shape, proportions and clothing define the character in the target video. The guide video provides the scene and the performance: its background, environment, lighting, camera, framing, body pose, hand and arm movement, head rotation, gaze direction, lip movement and facial expression, frame by frame; only the main subject of the guide video is replaced: its face, hair, body and clothing become <Subject 1>.  summary: [video generation + reference] Replace the guide subject with <Subject 1>, keeping the scene, camera and the complete motion and performance of the guide video.  detailed_description: [Shot 1] <Subject 1> takes the exact place of the guide subject and moves with the same timing, body pose, gestures, head motion, gaze, speech and facial expressions, while keeping the complete identity from <Picture 1>: facial structure, hair or fur, skin, body shape and clothing stay stable in every frame. The background, lighting, colors and camera of the guide video are preserved. Prevent identity drift, clothing changes, texture crawling and flicker.'
    else:
        setting = 'Replace the entire guide setting with the environment and visual style in <Picture 2>.' if background else 'Use the environment shown in <Picture 1> when it defines a setting; otherwise preserve the guide setting.'
        prompt = f'motion_transfer:\nsubject_definitions:\n<Subject 1> is the {details} in <Picture 1>; preserve its identity, body proportions, outfit and art style.\nsummary:\n[video generation + reference] Transfer the target performer\'s performance in <Video 1> to <Subject 1>, preserving action order, timing and camera movement. {setting}\nretention_analysis:\nPreserve the reference identity throughout the clip. Do not copy the source performer\'s face, body or clothes. The reference still pose is not the performance.\ndetailed_description:\n[Shot 1] Follow the target performer\'s poses, gestures, head movement and expression at matching times. Keep identity stable during occlusion, turns and back views. Do not turn a back view into a front view. Render the character in the reference art style. Normal real-time speed, no slow motion.\noverall_soundscape:\nPreserve the source soundtrack; do not invent dialogue.\nnon_diegetic_music:\nNo additional music requested.'
    prompt = '\n'.join(x for x in (target, prompt) if x)
    g = {}
    def node(id, cls, **inputs):
        g[str(id)] = {'class_type': cls, 'inputs': inputs}
    node(1, 'UNETLoader', unet_name='minimax_h3_ref2va_pruned_int8_convrot.safetensors', weight_dtype='default')
    node(3, 'LoraLoaderModelOnly', model=['1', 0], lora_name=TURBO, strength_model=1)
    node(4, 'LoraLoaderModelOnly', model=['3', 0], lora_name=SWAP_LORA if swap else MOTION_LORA, strength_model=1)
    node(5, 'ModelAttentionBackend', model=['4', 0], attention='pytorch attention')
    node(6, 'MiniMaxH3SigmaShift', model=['5', 0], shift_video=12, shift_audio=3)
    node(7, 'CLIPLoader', clip_name='qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type='minimax', device='default')
    node(8, 'VAELoader', vae_name='minimax_h3_video_vae_fp16.safetensors')
    node(11, 'LoadImage', image='character.png')
    node(29, 'LoadVideo', file='source.mp4')
    node(30, 'GetVideoComponents', video=['29', 0])
    node(31, 'ImageScale', image=['30', 0], upscale_method='lanczos', width=width, height=height, crop='disabled')
    node(32, 'ImageFromBatch', image=['31', 0], batch_index=0, length=length)
    refs = {'ref_images.ref_image_1': ['11', 0]}
    if not swap:
        refs['ref_videos.ref_video_1'] = ['32', 0]
        if background:
            node(12, 'LoadImage', image='background.png')
            refs['ref_images.ref_image_2'] = ['12', 0]
    if swap and audio:
        node(9, 'VAELoader', vae_name='minimax_h3_audio_vae_fp32.safetensors')
        refs['audio_vae'] = ['9', 0]
    node(13, 'MiniMaxH3ReferenceToVideo', clip=['7', 0], vae=['8', 0], prompt=prompt, width=width, height=height, length=length, ref_image_size='match', **refs)
    if swap:
        node(14, 'MiniMaxH3AddGuide', positive=['13', 0], latent=['13', 1], vae=['8', 0], image=['32', 0], frame_idx=0, **({'audio_vae':['9',0], 'audio':['30',1]} if audio else {}))
        model, positive, latent = ['6', 0], ['14', 0], ['13', 1]
    else:
        node(14, 'BFSMiniMaxH3NativeTemporal', model=['6',0], motion_video_index=1, strength=2., window_seconds=.2, falloff_seconds=.25, max_penalty=6., attention_backend='flash partitions (no compile)', structure_guidance=1., structure_sigma_min=0.)
        model, positive, latent = ['14', 0], ['13', 0], ['13', 1]
    node(15, 'CFGGuider', model=model, positive=positive, negative=positive, cfg=1)
    node(16, 'RandomNoise', noise_seed=parameters['seed'])
    node(17, 'KSamplerSelect', sampler_name='euler')
    node(18, 'BasicScheduler', model=model, scheduler='simple', steps=8, denoise=1)
    node(19, 'SamplerCustomAdvanced', noise=['16',0], guider=['15',0], sampler=['17',0], sigmas=['18',0], latent_image=latent)
    node(20, 'LTXVSeparateAVLatent', av_latent=['19',0])
    node(21, 'VAEDecodeTiled', samples=['20',0], vae=['8',0], tile_size=512, overlap=64, temporal_size=64, temporal_overlap=8)
    node(22, 'ImageFromBatch', image=['21',0], batch_index=0, length=length)
    node(23, 'CreateVideo', images=['22',0], fps=24, bit_depth='auto', color_space='sRGB', codec='none', **({'audio':['30',1]} if audio and parameters.get('keepAudio', True) else {}))
    node(24, 'SaveVideo', video=['23',0], filename_prefix='opencast/video', format='auto', **{'format.codec':'auto', 'codec':'auto'})
    return g
