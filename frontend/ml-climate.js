// Machine Learning Temperature Model
let tempModel = null;

async function trainClimateModel(data) {
    if (tempModel) return; // Already trained

    console.log("Training climate model...");

    // Prepare training data from districtsData
    const trainingData = data || districtsData;
    const inputs = [];
    const outputs = [];

    trainingData.forEach(d => {
        const tempVal = parseFloat(String(d.temp || '').replace(/[^\d.-]/g, ''));
        // Normalize lat/lng slightly to help training (simple scaling)
        inputs.push([d.lat / 20.0, d.lng / 100.0]); // Approximate normalization for TN lat/lng
        outputs.push([tempVal]);
    });

    const inputTensor = tf.tensor2d(inputs);
    const outputTensor = tf.tensor2d(outputs);

    // Define model
    tempModel = tf.sequential();
    tempModel.add(tf.layers.dense({ inputShape: [2], units: 16, activation: 'relu' }));
    tempModel.add(tf.layers.dense({ units: 16, activation: 'relu' }));
    tempModel.add(tf.layers.dense({ units: 1 })); // Linear output for regression

    tempModel.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' });

    // Train
    await tempModel.fit(inputTensor, outputTensor, { epochs: 100, shuffle: true, verbose: 0 });

    // Clean up tensors
    inputTensor.dispose();
    outputTensor.dispose();

    console.log("Climate model trained!");
}

async function predictClimate(lat, lng) {
    if (!tempModel) await trainClimateModel();

    return tf.tidy(() => {
        const input = tf.tensor2d([[lat / 20.0, lng / 100.0]]);
        const prediction = tempModel.predict(input);
        return prediction.dataSync()[0].toFixed(1);
    });
}
