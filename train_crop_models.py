
import tensorflow as tf
from tensorflow.keras import layers, models, applications
import json

# Configuration
IMG_SIZE_EFFICIENT = 300
IMG_SIZE_MOBILE = 224
BATCH_SIZE = 32
NUM_CLASSES = 500 # Based on your requirement

def build_transfer_model(base_model_type, img_size):
    if base_model_type == 'efficientnet':
        base_model = applications.EfficientNetB3(include_top=False, weights='imagenet', input_shape=(img_size, img_size, 3))
    elif base_model_type == 'mobilenet':
        base_model = applications.MobileNetV2(include_top=False, weights='imagenet', input_shape=(img_size, img_size, 3))
    else:
        base_model = applications.ResNet50(include_top=False, weights='imagenet', input_shape=(img_size, img_size, 3))
        
    base_model.trainable = False
    
    model = models.Sequential([
        base_model,
        layers.GlobalAveragePooling2D(),
        layers.Dense(512, activation='relu'),
        layers.Dropout(0.3),
        layers.Dense(NUM_CLASSES, activation='softmax')
    ])
    
    model.compile(optimizer='adam', loss='categorical_crossentropy', metrics=['accuracy'])
    return model

# Sample Training Flow
# 1. Load your 500+ crop dataset
# 2. Augment (Rotation, Flip, Zoom)
# 3. Train models
# 4. Save (.h5)

print("Training setup ready. Exporting models to .h5...")
# model_ef.save('efficientnet_crop_model.h5')
# model_mb.save('mobilenet_crop_model.h5')
