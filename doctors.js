const express = require('express');
const { body, validationResult, query } = require('express-validator');
const Doctor = require('../models/Doctor');
const Clinic = require('../models/Clinic');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/doctors
// @desc    Get all doctors with search and filter
// @access  Public
router.get('/', [
  query('search').optional().trim(),
  query('specialty').optional().trim(),
  query('city').optional().trim(),
  query('status').optional().isIn(['available', 'busy', 'offline']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      search,
      specialty,
      city,
      status,
      page = 1,
      limit = 10
    } = req.query;

    // Build filter object
    const filter = {};

    if (search) {
      filter.$or = [
        { specialty: { $regex: search, $options: 'i' } },
        { 'user.name': { $regex: search, $options: 'i' } }
      ];
    }

    if (specialty) {
      filter.specialty = { $regex: specialty, $options: 'i' };
    }

    if (status) {
      filter.status = status;
    }

    // If city is provided, we need to filter by clinic location
    let clinicFilter = {};
    if (city) {
      clinicFilter['address.city'] = { $regex: city, $options: 'i' };
    }

    const skip = (page - 1) * limit;

    // Get doctors with populated user and clinic data
    const doctors = await Doctor.find(filter)
      .populate('user', 'name email phone')
      .populate('currentClinic', 'name address phone')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ 'rating.average': -1, createdAt: -1 });

    // Filter by city if specified
    let filteredDoctors = doctors;
    if (city) {
      filteredDoctors = doctors.filter(doctor => 
        doctor.currentClinic && 
        doctor.currentClinic.address.city.toLowerCase().includes(city.toLowerCase())
      );
    }

    const total = await Doctor.countDocuments(filter);

    res.json({
      doctors: filteredDoctors,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalDoctors: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get doctors error:', error);
    res.status(500).json({ message: 'Server error while fetching doctors' });
  }
});

// @route   GET /api/doctors/:id
// @desc    Get single doctor by ID
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id)
      .populate('user', 'name email phone')
      .populate('currentClinic', 'name address phone email');

    if (!doctor) {
      return res.status(404).json({ message: 'Doctor not found' });
    }

    res.json({ doctor });
  } catch (error) {
    console.error('Get doctor error:', error);
    res.status(500).json({ message: 'Server error while fetching doctor' });
  }
});

// @route   POST /api/doctors
// @desc    Create a new doctor profile
// @access  Private (Doctor role)
router.post('/', auth, authorize('doctor'), [
  body('specialty').trim().notEmpty().withMessage('Specialty is required'),
  body('licenseNumber').trim().notEmpty().withMessage('License number is required'),
  body('experience').isInt({ min: 0 }).withMessage('Experience must be a non-negative integer'),
  body('consultationFee').isFloat({ min: 0 }).withMessage('Consultation fee must be a positive number'),
  body('bio').optional().isLength({ max: 1000 }).withMessage('Bio must be less than 1000 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check if doctor profile already exists
    const existingDoctor = await Doctor.findOne({ user: req.user._id });
    if (existingDoctor) {
      return res.status(400).json({ message: 'Doctor profile already exists' });
    }

    const doctorData = {
      user: req.user._id,
      ...req.body
    };

    const doctor = new Doctor(doctorData);
    await doctor.save();

    const populatedDoctor = await Doctor.findById(doctor._id)
      .populate('user', 'name email phone');

    res.status(201).json({
      message: 'Doctor profile created successfully',
      doctor: populatedDoctor
    });
  } catch (error) {
    console.error('Create doctor error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'License number already exists' });
    }
    res.status(500).json({ message: 'Server error while creating doctor profile' });
  }
});

// @route   PUT /api/doctors/:id/status
// @desc    Update doctor status
// @access  Private (Doctor or Clinic Admin)
router.put('/:id/status', auth, [
  body('status').isIn(['available', 'busy', 'offline']).withMessage('Invalid status'),
  body('clinicId').optional().isMongoId().withMessage('Invalid clinic ID')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { status, clinicId } = req.body;
    const doctorId = req.params.id;

    // Check if user can update this doctor's status
    const doctor = await Doctor.findById(doctorId);
    if (!doctor) {
      return res.status(404).json({ message: 'Doctor not found' });
    }

    // Allow doctor to update their own status or clinic admin to update their clinic's doctors
    const canUpdate = doctor.user.toString() === req.user._id.toString() || 
                     (req.user.role === 'clinic_admin' && doctor.currentClinic && 
                      doctor.currentClinic.toString() === clinicId);

    if (!canUpdate) {
      return res.status(403).json({ message: 'Not authorized to update this doctor status' });
    }

    const updateData = { status };
    if (clinicId) {
      updateData.currentClinic = clinicId;
    }

    const updatedDoctor = await Doctor.findByIdAndUpdate(
      doctorId,
      updateData,
      { new: true }
    ).populate('user', 'name email')
     .populate('currentClinic', 'name address');

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.emit('doctor-status-updated', {
        doctorId: updatedDoctor._id,
        status: updatedDoctor.status,
        doctorName: updatedDoctor.user.name,
        clinicId: updatedDoctor.currentClinic?._id,
        timestamp: new Date()
      });
    }

    res.json({
      message: 'Doctor status updated successfully',
      doctor: updatedDoctor
    });
  } catch (error) {
    console.error('Update doctor status error:', error);
    res.status(500).json({ message: 'Server error while updating doctor status' });
  }
});

// @route   PUT /api/doctors/:id
// @desc    Update doctor profile
// @access  Private (Doctor)
router.put('/:id', auth, authorize('doctor'), [
  body('specialty').optional().trim().notEmpty().withMessage('Specialty cannot be empty'),
  body('experience').optional().isInt({ min: 0 }).withMessage('Experience must be a non-negative integer'),
  body('consultationFee').optional().isFloat({ min: 0 }).withMessage('Consultation fee must be a positive number'),
  body('bio').optional().isLength({ max: 1000 }).withMessage('Bio must be less than 1000 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const doctor = await Doctor.findOne({ 
      _id: req.params.id, 
      user: req.user._id 
    });

    if (!doctor) {
      return res.status(404).json({ message: 'Doctor profile not found' });
    }

    const updatedDoctor = await Doctor.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('user', 'name email phone')
     .populate('currentClinic', 'name address phone');

    res.json({
      message: 'Doctor profile updated successfully',
      doctor: updatedDoctor
    });
  } catch (error) {
    console.error('Update doctor error:', error);
    res.status(500).json({ message: 'Server error while updating doctor profile' });
  }
});

module.exports = router;
