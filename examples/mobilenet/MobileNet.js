class MobileNet {
  constructor(tfModel, backend) {
    this._tfModel = tfModel;
    this._model = null;
    this._compilation;
    this._execution;
    this._tensorIds = [];
    this._operandIndex = 0;
    if (typeof backend !== 'undefined') {
      this._backend = backend;
    } else {
      if (nnNative && getPreferParam() !== 'invalid') {
        this._backend = 'WebML';
      } else {
        this._backend = 'WASM';
      }
    }
    if (this._backend === 'WebML') {
      if (nnNative === null) {
        throw Error('Fails to initialize neural network context');
      }
      this._nn = nnNative;
    } else if (this._backend === 'WASM' || this._backend === 'WebGL2') {
      this._nn = nnPolyfill;
    }
  }

  async createCompiledModel() {
    let options = {};
    if (this._backend === 'WebGL2') {
      options.useWebGL2 = true;
    }
    this._model = await this._nn.createModel(options);

    this._addTensorOperands();
    this._addOpsAndParams();

    await this._model.finish();
    this._compilation = await this._model.createCompilation();
    this._compilation.setPreference(getPrefer(this._backend));
    await this._compilation.finish();
    this._execution = await this._compilation.createExecution();
  }

  async compute(inputTensor, outputTensor) {
    this._execution.setInput(0, inputTensor);
    this._execution.setOutput(0, outputTensor);

    let error = await this._execution.startCompute();
    if (error) {
      return error;
    }
    return 'success';
  }

  _addTensorOperands() {
    let graph = this._tfModel.subgraphs(0);
    let tensorsLength = graph.tensorsLength();
    for (let i = 0; i < tensorsLength; ++i) {
      let tensor = graph.tensors(i);
      let type;
      let typedArray;
      switch (tensor.type()) {
        case tflite.TensorType.FLOAT32: {
          type = this._nn.TENSOR_FLOAT32;
          typedArray = Float32Array;
        } break;
        case tflite.TensorType.INT32: {
          type = this._nn.TENSOR_INT32;
          typedArray = Int32Array;
        } break;
        default: {
          throw new Error(`tensor type ${tensor.type()} is not supproted.`);
        }
      }
      let tensorType = {type: type, dimensions: Array.from(tensor.shapeArray())};
      let tensorId = this._operandIndex++;
      this._model.addOperand(tensorType);
      this._tensorIds.push(tensorId);
      let buffer = this._tfModel.buffers(tensor.buffer());
      if (buffer.dataLength() > 0) {
        let raw = buffer.dataArray();
        let data = new typedArray(raw.buffer, raw.byteOffset, raw.byteLength / typedArray.BYTES_PER_ELEMENT);
        this._model.setOperandValue(tensorId, data);
      }
    }

    let inputs = Array.from(graph.inputsArray());
    let outputs = Array.from(graph.outputsArray());
    this._model.identifyInputsAndOutputs(inputs, outputs);
  }

  _addScalarInt32(value) {
    const scalarInt32Type = {type: this._nn.INT32};
    let index = this._operandIndex++;
    this._model.addOperand(scalarInt32Type);
    this._model.setOperandValue(index, new Int32Array([value]));
    return index;
  }

  _addScalarFloat32(value) {
    const scalarInt32Type = {type: this._nn.FLOAT32};
    let index = this._operandIndex++;
    this._model.addOperand(scalarInt32Type);
    this._model.setOperandValue(index, new Float32Array([value]));
    return index;
  }

  _addOpsAndParams() {
    const PaddingCodeMap = new Map([
      [tflite.Padding.SAME, this._nn.PADDING_SAME],
      [tflite.Padding.VALID, this._nn.PADDING_VALID]
    ]);

    const FuseCodeMap = new Map([
      [tflite.ActivationFunctionType.NONE, this._nn.FUSED_NONE],
      [tflite.ActivationFunctionType.RELU, this._nn.FUSED_RELU],
      [tflite.ActivationFunctionType.RELU_N1_TO_1, this._nn.FUSED_RELU1],
      [tflite.ActivationFunctionType.RELU6, this._nn.FUSED_RELU6],
    ]);

    let graph = this._tfModel.subgraphs(0);
    let operatorsLength = graph.operatorsLength();
    for (let i = 0; i < operatorsLength; ++i) {
      let operator = graph.operators(i);
      let opCode = this._tfModel.operatorCodes(operator.opcodeIndex()).builtinCode();
      let opType;
      let inputs = Array.from(operator.inputsArray());
      let outputs = Array.from(operator.outputsArray());
      switch (opCode) {
        case tflite.BuiltinOperator.ADD: {
          let options = operator.builtinOptions(new tflite.AddOptions());
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.ADD;
        } break;
        case tflite.BuiltinOperator.CONV_2D: {
          let options = operator.builtinOptions(new tflite.Conv2DOptions());
          let paddingCode = PaddingCodeMap.get(options.padding());
          if (typeof paddingCode === 'undefined') {
            throw new Error(`Padding code ${options.padding()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(paddingCode));
          inputs.push(this._addScalarInt32(options.strideW()));
          inputs.push(this._addScalarInt32(options.strideH()));
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.CONV_2D;
        } break;
        case tflite.BuiltinOperator.DEPTHWISE_CONV_2D: {
          let options = operator.builtinOptions(new tflite.DepthwiseConv2DOptions());
          let paddingCode = PaddingCodeMap.get(options.padding());
          if (typeof paddingCode === 'undefined') {
            throw new Error(`Padding code ${options.padding()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(paddingCode));
          inputs.push(this._addScalarInt32(options.strideW()));
          inputs.push(this._addScalarInt32(options.strideH()));
          inputs.push(this._addScalarInt32(options.depthMultiplier()));
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.DEPTHWISE_CONV_2D;
        } break;
        case tflite.BuiltinOperator.AVERAGE_POOL_2D: {
          let options = operator.builtinOptions(new tflite.Pool2DOptions());
          let paddingCode = PaddingCodeMap.get(options.padding());
          if (typeof paddingCode === 'undefined') {
            throw new Error(`Padding code ${options.padding()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(paddingCode));
          inputs.push(this._addScalarInt32(options.strideW()));
          inputs.push(this._addScalarInt32(options.strideH()));
          inputs.push(this._addScalarInt32(options.filterWidth()));
          inputs.push(this._addScalarInt32(options.filterHeight()));
          let fuseCode = FuseCodeMap.get(options.fusedActivationFunction());
          if (typeof fuseCode === 'undefined') {
            throw new Error(`Fuse code ${options.fusedActivationFunction()} is not supported.`);
          }
          inputs.push(this._addScalarInt32(fuseCode));
          opType = this._nn.AVERAGE_POOL_2D;
        } break;
        case tflite.BuiltinOperator.SOFTMAX: {
          let options = operator.builtinOptions(new tflite.SoftmaxOptions());
          inputs.push(this._addScalarFloat32(options.beta()));
          opType = this._nn.SOFTMAX;
        } break;
        case tflite.BuiltinOperator.RESHAPE: {
          let options = operator.builtinOptions(new tflite.ReshapeOptions());
          //targetShape is in tensor
          opType = this._nn.RESHAPE;
        } break;
        case tflite.BuiltinOperator.SQUEEZE: {
          let options = operator.builtinOptions(new tflite.ReshapeOptions());
          //targetShape is in tensor
          let tensorType = {type: this._nn.TENSOR_INT32, dimensions: [2]};
          let tensorId = this._operandIndex++;
          this._model.addOperand(tensorType);
          this._tensorIds.push(tensorId);
          this._model.setOperandValue(tensorId, new Int32Array([1,1001]));
          inputs.push(tensorId);
          opType = this._nn.RESHAPE;
        } break;
        default: {
          throw new Error(`operator type ${opCode} is not supported.`);
        }
      }
      this._model.addOperation(opType, inputs, outputs);
    }
  }
}
